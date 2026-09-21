const http = require('http');
const admin = require("firebase-admin");

// --- KEEP-ALIVE SERVER (For Render/Cloud Hosts) ---
// Prevents the cloud hosting service from shutting down the worker
http.createServer((req, res) => res.end('AlphaCatch Worker is running!')).listen(process.env.PORT || 3000);

// --- CONFIGURATION ---
const BOT_TOKEN = "8783125069:AAEQtewJ-ikqVhOakiJEazutduY-BPwyp7U";
const FIREBASE_DB_URL = "https://agri-mcar-default-rtdb.firebaseio.com";

// Initialize Firebase Admin with Database URL
admin.initializeApp({
  databaseURL: FIREBASE_DB_URL
});

const db = admin.database();

// State Tracking
const GROUPS = ["ibps", "mcaer", "net"];
let updateOffset = 0;
let globalPollMap = {}; // Maps pollId -> { correctIndex, groupId, uIdScores }
let runningBatches = {
  ibps: false,
  mcaer: false,
  net: false
};

console.log("🚀 AlphaCatch Cloud Worker is active and listening for commands...");

// Start polling Telegram for student quiz answers continuously
listenForAnswers();

// Listen to Firebase for trigger commands for each exam group
GROUPS.forEach((groupId) => {
  const triggerRef = db.ref(`sky_exams/${groupId}/trigger`);
  
  triggerRef.on("value", async (snapshot) => {
    const trigger = snapshot.val();
    
    if (trigger && trigger.status === "pending") {
      if (runningBatches[groupId]) {
        console.log(`[${groupId.toUpperCase()}] Batch already in progress. Skipping trigger.`);
        return;
      }

      console.log(`[${groupId.toUpperCase()}] New batch trigger received.`);
      
      // Acknowledge trigger
      await triggerRef.update({ status: "running" });

      try {
        await executeBatch(groupId, trigger);
        await triggerRef.update({ status: "completed", finishedAt: Date.now() });
      } catch (err) {
        console.error(`[${groupId.toUpperCase()}] Batch execution error:`, err);
        await triggerRef.update({ status: "failed", error: err.message });
      }
    }
  });
});

// --- TELEGRAM API HELPER ---
async function telegramRequest(method, payload) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  
  // Use native fetch (Node 18+) or fallback to node-fetch if running on older environments
  const fetchClient = typeof fetch === "function" ? fetch : require("node-fetch");
  
  const response = await fetchClient(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await response.json();
}

// --- EXAM EXECUTION ENGINE ---
async function executeBatch(groupId, config) {
  runningBatches[groupId] = true;

  const chatId = config.chatId;
  const batchSize = parseInt(config.batchSize) || 30;
  const timerSec = parseInt(config.timerSec) || 15;
  const delayGap = parseInt(config.delayGap) || 5;
  const isProtected = config.protectContent !== false;

  // 1. Fetch current question database & progress from Firebase
  const examSnap = await db.ref(`sky_exams/${groupId}`).once("value");
  const examData = examSnap.val() || {};

  const allQuestions = examData.questions || [];
  const currentIndex = parseInt(examData.currentIndex) || 0;

  if (allQuestions.length === 0) {
    throw new Error("No questions available in Firebase database.");
  }

  if (currentIndex >= allQuestions.length) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: `🎉 <b>${groupId.toUpperCase()} Exam Series Completed!</b>\nAll available questions have already been served.`,
      parse_mode: "HTML"
    });
    runningBatches[groupId] = false;
    return;
  }

  const endIndex = Math.min(currentIndex + batchSize, allQuestions.length);
  const batchQuestions = allQuestions.slice(currentIndex, endIndex);
  const batchScores = {}; // Local score tracker for this batch

  console.log(`[${groupId.toUpperCase()}] Starting questions Q${currentIndex + 1} to Q${endIndex}...`);

  // 2. Iterate and send questions
  for (let i = 0; i < batchQuestions.length; i++) {
    const qIndexNumber = currentIndex + i + 1;
    const item = batchQuestions[i];

    let correctIndex = item.options.indexOf(item.answer);
    if (correctIndex === -1) correctIndex = 0;

    const pollPayload = {
      chat_id: chatId,
      question: `[Q${qIndexNumber} - ${groupId.toUpperCase()}] ${item.question.substring(0, 270)}`,
      options: JSON.stringify(item.options.slice(0, 10)),
      type: "quiz",
      correct_option_id: correctIndex,
      is_anonymous: false,
      open_period: timerSec,
      protect_content: isProtected
    };

    if (item.explanation) {
      pollPayload.explanation = item.explanation.substring(0, 200);
    }

    const pollRes = await telegramRequest("sendPoll", pollPayload);

    if (pollRes.ok) {
      const pollId = pollRes.result.poll.id;
      globalPollMap[pollId] = {
        correctIndex: correctIndex,
        groupId: groupId,
        scoresRef: batchScores
      };
    } else {
      console.error(`[${groupId.toUpperCase()}] Telegram Error on Q${qIndexNumber}:`, pollRes.description);
    }

    // Question cooldown
    if (i < batchQuestions.length - 1) {
      const waitTime = timerSec + delayGap;
      await sleep(waitTime * 1000);
    } else {
      // Allow last question to finish
      await sleep(timerSec * 1000);
    }
  }

  // 3. Update Progress in Firebase
  await db.ref(`sky_exams/${groupId}/currentIndex`).set(endIndex);

  // 4. Send Results Leaderboard
  await sleep(2000);
  await postLeaderboard(groupId, chatId, batchScores, batchQuestions.length);

  runningBatches[groupId] = false;
  console.log(`[${groupId.toUpperCase()}] Batch completed successfully.`);
}

// --- LEADERBOARD SENDER ---
async function postLeaderboard(groupId, chatId, scoresMap, totalQuestions) {
  const sorted = Object.values(scoresMap).sort((a, b) => b.score - a.score);

  let text = `🏆 <b>TODAY'S ${groupId.toUpperCase()} LEADERBOARD</b> 🏆\n`;
  text += `📝 <b>Questions in this session:</b> ${totalQuestions}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (sorted.length === 0) {
    text += "<i>No answers were recorded during this session.</i>";
  } else {
    sorted.forEach((user, idx) => {
      let medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "🔹";
      text += `${medal} <b>${user.name}</b>: ${user.score} pts\n`;
    });
  }

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML"
  });
}

// --- ANSWER LISTENER (LONG-POLLING) ---
async function listenForAnswers() {
  while (true) {
    try {
      const res = await telegramRequest("getUpdates", {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: ["poll_answer"]
      });

      if (res.ok && res.result.length > 0) {
        for (const update of res.result) {
          updateOffset = update.update_id + 1;

          if (update.poll_answer) {
            const ans = update.poll_answer;
            const pollData = globalPollMap[ans.poll_id];

            if (pollData) {
              const uId = ans.user.id;
              const rawName = ans.user.first_name + (ans.user.last_name ? " " + ans.user.last_name : "");
              const uName = rawName.replace(/</g, "&lt;").replace(/>/g, "&gt;");

              if (!pollData.scoresRef[uId]) {
                pollData.scoresRef[uId] = { name: uName, score: 0 };
              }

              if (pollData.correctIndex === ans.option_ids[0]) {
                pollData.scoresRef[uId].score += 1;
              }
            }
          }
        }
      }
    } catch (err) {
      // Reconnect delay on network drops
      await sleep(3000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
