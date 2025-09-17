import fs from "fs";
import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const users = new Set();

function saveUsers() {
  fs.writeFileSync("users.json", JSON.stringify([...users], null, 2));
}

function loadUsers() {
  if (fs.existsSync("users.json")) {
    const data = JSON.parse(fs.readFileSync("users.json"));
    data.forEach(id => users.add(id));
  }
}

// Хранилище для дел пользователей
const userTodos = {};
loadUsers();
console.log("Загружены пользователи:", [...users]);

// --------------------- Google Sheets ---------------------
export async function getCellValue(cell) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.value;
  } catch (err) {
    console.error("Ошибка при получении данных из Google Sheets:", err);
    return null;
  }
}

export async function setCellValue(cell, value) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}&value=${value}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.status === "ok";
  } catch (err) {
    console.error("Ошибка при записи в Google Sheets:", err);
    return false;
  }
}

// --------------------- Планы ---------------------
function getTodoKeyboard(userId) {
  const todos = userTodos[userId] || [];
  return {
    reply_markup: {
      inline_keyboard: [
        ...todos.map((t, i) => [
          {
            text: `${t.done ? "✅" : "☑️"} ${t.text}`,
            callback_data: `toggle_${i}`,
          },
        ]),
      ],
    },
  };
}

function editDate(date) {
  const weekday = date.getDay();
  switch (weekday) {
    case 1: return 'D';
    case 2: return 'J';
    case 3: return 'P';
    case 4: return 'V';
    case 5: return 'AB';
    case 6: return 'AH';
    case 0: return 'AN';
    default: return 'D';
  }
}

function func_week_number(date) {
  const dayOfMonth = date.getDate();
  let weekday = date.getDay();
  let week_number = 1;
  let vskr;
  if(dayOfMonth - weekday > 0 && weekday != 0){
    vskr = dayOfMonth - weekday;
    week_number += 1;
  } else {
    vskr = dayOfMonth + weekday;
  }
  for(let i = vskr; i > 7; i -= 7){
    week_number++;
  }
  return week_number;
}

async function sendDailyMessage(chatId, loadingMessage = null, dateStr = null) {
  let curDate = new Date();
  let wn = func_week_number(curDate);
  let str = editDate(curDate);

  let checkCol;
  if (str.length === 1) {
    checkCol = String.fromCharCode(str.charCodeAt(0) - 1);
  } else {
    checkCol = str[0] + String.fromCharCode(str.charCodeAt(1) - 1);
  }

  const userTasks = {};
  const numTasks = 8;

  for (let i = 1; i <= numTasks; i++) {
    const taskRow = (2 + (10 * wn)) + i;
    const taskCell = `${str}${taskRow}`;
    const checkCell = `${checkCol}${taskRow}`;

    const taskText = await getCellValue(taskCell);
    if (!taskText) continue;

    const taskCheckRaw = await getCellValue(checkCell);
    const taskDone = taskCheckRaw === true || taskCheckRaw === "TRUE" || taskCheckRaw === "1";

    userTasks[`task${i}`] = { text: taskText, done: taskDone, cell: checkCell };
  }

  const tasksArray = Object.values(userTasks);

  if (tasksArray.length === 0) {
    if (loadingMessage) {
      await bot.telegram.editMessageText(
        chatId,
        loadingMessage.message_id,
        undefined,
        `📅 Планы на ${dateStr} отсутствуют.`
      );
    }
    return;
  }

  if (!userTodos[chatId]) userTodos[chatId] = tasksArray;

  try {
    if (loadingMessage) {
      await bot.telegram.editMessageText(
        chatId,
        loadingMessage.message_id,
        undefined,
        `📅 Планы на ${dateStr}:`,
        { reply_markup: getTodoKeyboard(chatId).reply_markup }
      );
    } else {
      await bot.telegram.sendMessage(
        chatId,
        `📅 Планы на ${dateStr}:`,
        getTodoKeyboard(chatId)
      );
    }
  } catch (err) {
    console.error("Ошибка при отправке сообщения:", err);
  }
}

// --------------------- Привычки ---------------------
function formatTimeFromSheet(timeStr) {
  if (!timeStr) return "";
  const match = timeStr.match(/(\d{1,2}):(\d{1,2})/);
  if (!match) return "";
  return `${match[1].padStart(2,'0')}:${match[2].padStart(2,'0')}`;
}

abot.command("habits", async (ctx) => {
  try {
    await bot.telegram.sendChatAction(ctx.chat.id, "typing");

    const now = new Date();
    const weekday = now.getDay(); // 0 = вс, 1 = пн ...

    const colMap = ['J','K','L','M','N','O','P']; // пн-вс
    let text = "🌞 Утренние привычки:\n";

    for (let i = 0; i < 5; i++) {
      const habitCell = `C${4 + i}`;
      const timeCell = `${colMap[weekday]}${4 + i}`;

      let habitName = await getCellValue(habitCell);
      let habitTimeRaw = await getCellValue(timeCell);

      if (!habitName) habitName = `Привычка ${i+1}`;
      let habitTime = habitTimeRaw || "—";

      text += `- ${habitName} (${habitTime})\n`;
    }

    await ctx.reply(text);
  } catch (err) {
    console.error("Ошибка при выводе привычек:", err);
    await ctx.reply("❌ Ошибка при загрузке привычек");
  }
});


// --------------------- Команды ---------------------
bot.start((ctx) => {
  users.add(ctx.from.id);
  saveUsers();
  ctx.reply("✅ Ты подписан на ежедневные уведомления!");
});

bot.command("id", (ctx) => {
  ctx.reply(`Твой Telegram ID: ${ctx.from.id}`);
  users.add(ctx.from.id);
});

bot.command("today", async (ctx) => {
  try {
    await ctx.sendChatAction("typing");
    const loadingMessage = await ctx.reply("⏳ Загружаю планы...");
    const curDate = new Date();
    const dateStr = curDate.toLocaleDateString("ru-RU", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    await sendDailyMessage(ctx.chat.id, loadingMessage, dateStr);
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Ошибка при загрузке планов");
  }
});

bot.command("habits", async (ctx) => {
  try {
    await sendMorningHabits(ctx.chat.id);
  } catch (err) {
    console.error("Ошибка при отправке привычек:", err);
    await ctx.reply("❌ Ошибка при загрузке привычек");
  }
});

// --------------------- Callback ---------------------
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.from.id;
  const data = ctx.callbackQuery.data;

  if (data.startsWith("toggle_")) {
    const index = parseInt(data.split("_")[1]);
    const todo = userTodos[chatId][index];
    todo.done = !todo.done;
    await setCellValue(todo.cell, todo.done ? "TRUE" : "FALSE");
    await ctx.editMessageReplyMarkup(getTodoKeyboard(chatId).reply_markup);
    await ctx.answerCbQuery();
  } else if (data.startsWith("habit_")) {
    const cell = data.split("_")[1];
    const doneRaw = await getCellValue(cell);
    const done = doneRaw === true || doneRaw === "TRUE" || doneRaw === "1";
    await setCellValue(cell, done ? "FALSE" : "TRUE");
    await ctx.answerCbQuery("Отметка обновлена");
    await sendMorningHabits(chatId);
  }
});

// --------------------- Cron ---------------------
cron.schedule("0 09 * * *", () => {
  const curDate = new Date();
  const dateStr = curDate.toLocaleDateString("ru-RU", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  users.forEach((id) => sendDailyMessage(id, null, dateStr));
}, { timezone: "Europe/Moscow" });

cron.schedule("50 08 * * *", () => {
  users.forEach((id) => sendMorningHabits(id));
}, { timezone: "Europe/Moscow" });

// --------------------- Запуск ---------------------
bot.launch().then(() => console.log("🤖 Бот запущен!"));
