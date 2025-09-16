import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const users = new Set();

// Хранилище для дел пользователей
const userTodos = {};

// Функция получения одной ячейки
async function getCellValue(cell) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}`;
    const res = await fetch(url);
    const data = await res.json(); // { value: "текущее значение ячейки" }
    return data.value;
  } catch (err) {
    console.error("Ошибка при получении данных из Google Sheets:", err);
    return null;
  }
}
async function setCellValue(cell, value) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}&value=${encodeURIComponent(value)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.status === "ok";
  } catch (err) {
    console.error("Ошибка при записи в Google Sheets:", err);
    return false;
  }
}

// Генерация клавиатуры со списком дел
function getTodoKeyboard(userId) {
  const todos =
    userTodos[userId] ||
    [
      { text: "Сходить в магазин", done: false },
      { text: "Сделать домашку", done: false },
      { text: "Почитать книгу", done: false },
    ];

  return {
    reply_markup: {
      inline_keyboard: [
        ...todos.map((t, i) => [
          {
            text: `${t.done ? "✅" : "☑️"} ${t.text}`,
            callback_data: `toggle_${i}`,
          },
        ]),
        [{ text: "Готово", callback_data: "done" }],
      ],
    },
  };
}

function editDate(date) {
  let currentDate = new Date(date);
  let weekday = currentDate.getDay();
  let str = '';
  switch(weekday) {
  case 1: 
    str = 'D';
    break;
  case 2: 
    str = 'J';
    break;
  case 3: 
    str = 'P';
    break;
  case 4: 
    str = 'V';
    break;
  case 5: 
    str = 'AB';
    break;
  case 6: 
    str = 'AH';
    break;
  case 0: 
    str = 'AN';
    break;
  default:
    break;
}
return str;
}

function func_week_number(date){
  
  const dayOfMonth = date.getDate();
  let weekday = date.getDay();
  let week_number = 1;
  let vskr;
  if(dayOfMonth - weekday > 0 && weekday != 0){
   vskr = dayOfMonth - weekday;
   week_number = week_number + 1;
  } else {
    vskr = dayOfMonth + weekday;
  }
  for(let i = vskr; i > 7; i = i - 7){
    week_number++;
  }
  return week_number
}


// Отправка сообщения пользователю
async function sendDailyMessage(chatId) {
  let curDate = new Date();
  let wn = func_week_number(curDate);
  let str = editDate(curDate);
   let charCode;
    let numstr;
    if(str.length > 1){
      charCode = str.charCodeAt(1);  
      numstr = str[0] + String.fromCharCode(charCode - 1);
    } else {
      charCode = str.charCodeAt(0);  
      numstr = String.fromCharCode(charCode - 1);
    }
  const userTasks = {}; // объект для хранения задач
  const numTasks = 8; // количество задач, которое нужно загрузить

  for (let i = 1; i <= numTasks; i++) {
    const taskCell = `${str}${(2 + (10*wn)) + i}`; // текст задачи
    const checkCell = `${numstr}${(2 + (10*wn)) + i}`; // статус задачи

    const taskText = await getCellValue(taskCell);
    if (!taskText) continue; // если значение null или пустое, пропускаем

    const taskCheckRaw = await getCellValue(checkCell);
    const taskDone = taskCheckRaw === true || taskCheckRaw === "TRUE" || taskCheckRaw === "1";

    userTasks[`task${i}`] = {
      text: taskText,
      done: taskDone,
    };
  }

  // Преобразуем объект в массив, только если есть задачи
  const tasksArray = Object.values(userTasks);
  if (tasksArray.length === 0) return; // нет задач — не отправляем сообщение

  if (!userTodos[chatId]) {
    userTodos[chatId] = tasksArray;
  }

  const message = `📝 Список дел на ${curDate}:`;
  try {
    await bot.telegram.sendMessage(chatId, message, getTodoKeyboard(chatId));
  } catch (err) {
    console.error("Ошибка при отправке сообщения:", err);
  }
}

// Команды бота
bot.start((ctx) => {
  ctx.reply("Привет! Я буду отправлять ежедневные уведомления.");
  users.add(ctx.from.id);
  console.log("Добавлен пользователь:", ctx.from.id);
});

bot.command("id", (ctx) => {
  ctx.reply(`Твой Telegram ID: ${ctx.from.id}`);
  users.add(ctx.from.id);
  console.log("Добавлен пользователь:", ctx.from.id);
});

// Обработка нажатий по чекбоксам
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.from.id;
  const data = ctx.callbackQuery.data;

  if (!userTodos[chatId]) return;

  if (data.startsWith("toggle_")) {
    const index = parseInt(data.split("_")[1]); // номер задачи
    const todo = userTodos[chatId][index];
    let curDate = new Date();
    let str = editDate(curDate);
    let wn = func_week_number(curDate);

    // находим колонку для чекбокса (соседняя слева от текста)
    let charCode;
    let numstr;
    if (str.length > 1) {
      charCode = str.charCodeAt(1);  
      numstr = str[0] + String.fromCharCode(charCode - 1);
    } else {
      charCode = str.charCodeAt(0);  
      numstr = String.fromCharCode(charCode - 1);
    }

    // строка в таблице (та же логика, что и при загрузке)
    const row = (2 + (10 * wn)) + (index + 1);

    // меняем локально
    todo.done = !todo.done;

    // обновляем таблицу
    const checkCell = `${numstr}${row}`;
    await setCellValue(checkCell, todo.done ? "TRUE" : "FALSE");

    // обновляем клавиатуру в боте
    await ctx.editMessageReplyMarkup(getTodoKeyboard(chatId).reply_markup);
    await ctx.answerCbQuery();
  }
});
bot.command("today", async (ctx) => {
  const chatId = ctx.from.id;
  await sendDailyMessage(chatId); // отправка текущих задач
});
// Запуск бота
bot.launch().then(() => console.log("🤖 Бот запущен!"));

// Планировщик: каждый день в 10:00 (сейчас стоит каждую минуту для теста)
cron.schedule("0 10 * * *", () => {
  console.log("Отправляем ежедневное сообщение...");
  users.forEach((id) => sendDailyMessage(id));
});