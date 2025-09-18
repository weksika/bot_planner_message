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

const userTodos = {};
const userHabitMessages = {};
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
      inline_keyboard: todos.map((t, i) => [
        { text: `${t.done ? "✅" : "☑️"} ${t.text}`, callback_data: `toggle_${i}` },
      ]),
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
  if (dayOfMonth - weekday > 0 && weekday !== 0) {
    vskr = dayOfMonth - weekday;
    week_number += 1;
  } else {
    vskr = dayOfMonth + weekday;
  }
  for (let i = vskr; i > 7; i -= 7) week_number++;
  return week_number;
}

async function sendDailyMessage(chatId, loadingMessage = null, dateStr = null) {
  console.log("🔍 sendDailyMessage стартовал для:", chatId, "с датой:", dateStr);
  const curDate = new Date();
  const wn = func_week_number(curDate);
  const str = editDate(curDate);

  let checkCol;
  if (str.length === 1) {
    checkCol = String.fromCharCode(str.charCodeAt(0) - 1);
  } else {
    checkCol = str[0] + String.fromCharCode(str.charCodeAt(1) - 1);
  }

  const userTasks = {};
  const numTasks = 8;

  for (let i = 1; i <= numTasks; i++) {
    try {
      const taskRow = (2 + (10 * wn)) + i;
      const taskCell = `${str}${taskRow}`;
      const checkCell = `${checkCol}${taskRow}`;

      console.log(`📌 Получаем задачу из ячейки: ${taskCell}`);
      const taskText = await getCellValue(taskCell);
      if (!taskText) {
        console.log(`⚠️ Пустая ячейка: ${taskCell}`);
        continue;
      }

      const taskCheckRaw = await getCellValue(checkCell);
      const taskDone = taskCheckRaw === true || taskCheckRaw === "TRUE" || taskCheckRaw === "1";

      userTasks[`task${i}`] = { text: taskText, done: taskDone, cell: checkCell };
      console.log(`✔️ Задача ${i}:`, taskText, "Done:", taskDone);
    } catch (err) {
      console.error(`❌ Ошибка при обработке задачи ${i}:`, err.stack || err);
    }
  }

  const tasksArray = Object.values(userTasks);

  if (tasksArray.length === 0) {
    console.log("⚠️ Нет задач для отправки");
    if (loadingMessage) {
      try {
        await bot.telegram.editMessageText(
          chatId,
          loadingMessage.message_id,
          undefined,
          `📅 Планы на ${dateStr} отсутствуют.`
        );
      } catch (err) {
        console.error("❌ Ошибка при отправке сообщения о пустых планах:", err.stack || err);
      }
    }
    console.log("🏁 sendDailyMessage завершён для:", chatId);
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
      await bot.telegram.sendMessage(chatId, `📅 Планы на ${dateStr}:`, getTodoKeyboard(chatId));
    }
    console.log("✅ Сообщение с планами отправлено пользователю:", chatId);
  } catch (err) {
    console.error(`❌ Ошибка при отправке сообщения пользователю ${chatId}:`, err.stack || err);
  }

  console.log("🏁 sendDailyMessage завершён для:", chatId);
}

// --------------------- Привычки ---------------------
function formatTimeFromSheet(timeValue) {
  if (timeValue == null || timeValue === "") return "";
  let hours = 0;
  let minutes = 0;

  if (typeof timeValue === "number") {
    const totalMinutes = Math.round(timeValue * 24 * 60);
    hours = Math.floor(totalMinutes / 60);
    minutes = totalMinutes % 60;
  } else if (typeof timeValue === "string") {
    const match = timeValue.match(/(\d{1,2}):(\d{1,2})/);
    if (match) {
      hours = parseInt(match[1], 10);
      minutes = parseInt(match[2], 10);
    } else {
      const date = new Date(timeValue);
      if (!isNaN(date)) {
        hours = date.getHours();
        minutes = date.getMinutes();
      }
    }
  }

  return `${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}`;
}

function getColumnName(colNumber) {
  let name = "";
  while (colNumber > 0) {
    colNumber--; // Сдвиг для 0-индекса
    name = String.fromCharCode(65 + (colNumber % 26)) + name;
    colNumber = Math.floor(colNumber / 26);
  }
  return name;
}

async function sendMorningHabits(userId) {
  const now = new Date();
  const weekday = now.getDay(); // 0 = вс, 1 = пн ...
  const dayOfMonth = now.getDate(); // 1..31
  const colMap = ['P','J','K','L','M','N','O']; // столбцы с временем по дню недели
  const habits = [];

  for (let i = 0; i < 5; i++) {
    const habitCell = `C${4 + i}`; // название привычки
    const timeCell = `${colMap[weekday]}${4 + i}`; // время привычки
    const habitName = await getCellValue(habitCell) || `Привычка ${i+1}`;
    const habitTimeRaw = await getCellValue(timeCell);

    // формируем корректное время
    let habitTime = "";
    if (habitTimeRaw != null && habitTimeRaw !== "") {
      if (typeof habitTimeRaw === "number") {
        const totalMinutes = Math.round(habitTimeRaw * 24 * 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        habitTime = `${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}`;
      } else {
        const match = habitTimeRaw.toString().match(/(\d{1,2}):(\d{1,2})/);
        if (match) habitTime = `${match[1].padStart(2,'0')}:${match[2].padStart(2,'0')}`;
      }
    }

    // если времени нет — пропускаем привычку
    if (!habitTime) continue;

    const checkCol = getColumnName(17 + dayOfMonth - 1); // Q=17-я колонка
    const checkCell = `${checkCol}${4 + i}`;
    const doneRaw = await getCellValue(checkCell);
    const done = doneRaw === true || doneRaw === "TRUE" || doneRaw === "1";

    habits.push({
      name: habitName,
      time: habitTime,
      checkCell,
      done
    });
  }

  const buttons = habits.map(h => [{
    text: `${h.done ? "✅" : "☑️"} ${h.name} (${h.time})`,
    callback_data: `habit_${h.checkCell}`
  }]);

  const textToSend = buttons.length ? "🌞 Утренние привычки:" : "Нет привычек на сегодня.";

  try {
    if (userHabitMessages[userId]) {
      // редактируем существующее сообщение
      await bot.telegram.editMessageText(
        userId,
        userHabitMessages[userId],
        undefined,
        textToSend,
        { reply_markup: { inline_keyboard: buttons } }
      );
    } else {
      // отправляем новое сообщение и сохраняем message_id
      const msg = await bot.telegram.sendMessage(userId, textToSend, {
        reply_markup: { inline_keyboard: buttons }
      });
      userHabitMessages[userId] = msg.message_id;
    }
  } catch (err) {
    console.error("Ошибка при выводе привычек:", err);
  }
}

// --------------------- Callback ---------------------
bot.on("callback_query", async ctx => {
  try {
    await ctx.answerCbQuery("⏳ Обновляю..."); // ответ сразу, в пределах 10 секунд

    const chatId = ctx.from.id;
    const data = ctx.callbackQuery.data;

    if (data.startsWith("habit_")) {
      const cell = data.split("_")[1];
      const doneRaw = await getCellValue(cell);
      const done = doneRaw === true || doneRaw === "TRUE" || doneRaw === "1";
      await setCellValue(cell, done ? "FALSE" : "TRUE");

      // обновляем привычки в том же сообщении
      await sendMorningHabits(chatId);
    }
  } catch (err) {
    console.error("Ошибка при обработке callback_query привычек:", err);
  }
});



// --------------------- Команды ---------------------
bot.start(ctx => {
  users.add(ctx.from.id);
  saveUsers();
  ctx.reply("✅ Ты подписан на ежедневные уведомления!");
});

bot.command("id", ctx => {
  ctx.reply(`Твой Telegram ID: ${ctx.from.id}`);
  users.add(ctx.from.id);
});

bot.command("today", async ctx => {
  try {
    await ctx.sendChatAction("typing");
    const loadingMessage = await ctx.reply("⏳ Загружаю планы...");
    const curDate = new Date();
    const dateStr = curDate.toLocaleDateString("ru-RU", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    await sendDailyMessage(ctx.chat.id, loadingMessage, dateStr);
  } catch (err) {
    console.error(err);
    ctx.reply("❌ Ошибка при загрузке планов");
  }
});

bot.command("habits", async ctx => {
  try {
    await ctx.sendChatAction("typing");
    await sendMorningHabits(ctx.chat.id);
  } catch (err) {
    console.error("Ошибка при выводе привычек:", err);
    ctx.reply("❌ Ошибка при загрузке привычек");
  }
});

// --------------------- Callback ---------------------
bot.on("callback_query", async ctx => {
  try {
    await ctx.answerCbQuery("⏳ Обновляю..."); // ответ сразу, в пределах 10 секунд

    const chatId = ctx.from.id;
    const data = ctx.callbackQuery.data;

    if (data.startsWith("toggle_")) {
      const index = parseInt(data.split("_")[1]);
      const todo = userTodos[chatId][index];
      todo.done = !todo.done;
      await setCellValue(todo.cell, todo.done ? "TRUE" : "FALSE");
      await ctx.editMessageReplyMarkup(getTodoKeyboard(chatId).reply_markup);
    } else if (data.startsWith("habit_")) {
      const cell = data.split("_")[1];
      const doneRaw = await getCellValue(cell);
      const done = doneRaw === true || doneRaw === "TRUE" || doneRaw === "1";
      await setCellValue(cell, done ? "FALSE" : "TRUE");
      await sendMorningHabits(chatId);
    }
  } catch (err) {
    console.error("Ошибка при обработке callback_query:", err);
  }
});


// --------------------- Cron ---------------------
cron.schedule("10 07 * * *", async () => {
  const curDate = new Date();
  const dateStr = curDate.toLocaleDateString("ru-RU", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  console.log("🕒 CRON (daily plans) triggered at:", curDate.toISOString());
  console.log("📋 USERS:", [...users]);

  if (users.size === 0) {
    console.log("⚠️ Нет пользователей для рассылки");
    return;
  }

  for (const id of users) {
    try {
      console.log(`➡️ Отправляю планы пользователю ${id}`);
      await sendDailyMessage(id, null, dateStr);
      console.log(`✅ Успешно отправлено пользователю ${id}`);
    } catch (err) {
      console.error(`❌ Ошибка при отправке пользователю ${id}:`, err);
    }
  }
}, { timezone: "Europe/Moscow" });


// Утренние привычки (например, 08:50 МСК)
cron.schedule("20 07 * * *", async () => {
  const curDate = new Date();
  console.log("🕒 CRON (morning habits) triggered at:", curDate.toISOString());
  console.log("📋 USERS:", [...users]);

  if (users.size === 0) {
    console.log("⚠️ Нет пользователей для рассылки");
    return;
  }

  for (const id of users) {
    try {
      console.log(`➡️ Отправляю привычки пользователю ${id}`);
      await sendMorningHabits(id);
      console.log(`✅ Успешно отправлено пользователю ${id}`);
    } catch (err) {
      console.error(`❌ Ошибка при отправке пользователю ${id}:`, err);
    }
  }
}, { timezone: "Europe/Moscow" });
// --------------------- Запуск ---------------------
bot.launch().then(() => console.log("🤖 Бот запущен!"));
