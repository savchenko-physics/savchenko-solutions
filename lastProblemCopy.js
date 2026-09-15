// Every word of «Последняя задача» (lastProblem.js, views/apps/last_problem.ejs,
// js/apps/last-problem.js), in both languages, kept together the way feedbackQuestions.js keeps
// the feedback box: in a game the wording is most of the design, and it is easier to read in one
// place than scattered through templates and locales.
//
// No em or en dashes (the owner's rule for anything the site says), and amounts as "100 ħ".
'use strict';

const COPY = {
    ru: {
        appName: 'Последняя задача',
        appKind: 'мини-приложение',
        host: 'Демон Лапласа',
        question: 'Какая задача будет решена последней?',
        close: 'Закрыть',
        openInChat: 'Открыть в чате',
        tabs: { market: 'Прогноз', top: 'Рейтинг', shop: 'Реакции' },

        welcomeTitle: 'Ваш стартовый баланс',
        welcomeClaim: 'Забрать',
        welcomeNote: 'Кванты игрушечные: их нельзя купить или вывести. Их можно выиграть на прогнозах и потратить на реакции в чате.',
        signIn: 'Войдите, чтобы получить 1 000 ħ и делать прогнозы',
        signInButton: 'Войти',

        balance: 'Баланс',
        groundState: 'Основное состояние · ½ħω',
        opened: 'Открыт 15 сентября вопросом emixter в чате',
        decidedBanner: 'Осталась одна задача: {problem}. Если за 72 часа ничего не изменится, её доли будут выплачены.',
        resolvedBanner: 'Последней оказалась {problem}. Доли выплачены, спасибо всем, кто решал и предсказывал.',
        traders: ['участник', 'участника', 'участников'],
        problemsLeft: ['задача осталась', 'задачи осталось', 'задач осталось'],
        chance: 'шанс',
        payout: 'выплата',
        buy: 'Купить',
        sell: 'Продать',
        sellAll: 'Продать всё',
        sellHalf: 'Продать половину',
        bought: 'Куплено',
        sold: 'Продано',
        amount: 'Сумма',
        max: 'Всё',
        confirmBuy: 'Купить за',
        youGet: 'Вы получите',
        shares: ['долю', 'доли', 'долей'],
        ifLast: 'если задача окажется последней',
        yourPositions: 'Ваши прогнозы',
        worthNow: 'сейчас стоит',
        spent: 'вложено',
        fromChat: 'из чата',
        cancelChatBet: 'Отменить и вернуть',
        solvedList: 'Решены после открытия',
        solvedBy: 'решение',
        statement: 'Условие',
        recent: 'Последние события',
        feedBuy: 'купил(а)',
        feedSell: 'продал(а)',
        feedSolved: 'решена, выбывает',
        demonName: 'Демон Лапласа',
        rulesTitle: 'Правила',
        rules: [
            'Рынок открыт 15 сентября, когда emixter спросил в чате, какая задача будет решена последней. В игре задачи, которые тогда были не решены.',
            'Задача считается решённой, когда на сайте появляется её решение на любом языке. Пустой шаблон со страницы «Добавить задачу» не считается.',
            'Цена задачи в процентах: шанс, который ей даёт рынок. Одна доля стоит столько же в квантах, а если задача окажется последней, каждая доля принесёт 1 ħ. Множитель показывает, во сколько раз вырастет ставка.',
            'Купить и продать можно в любой момент. Второй стороной сделки выступает сам рынок (LMSR, b = 1000), поэтому каждая сделка двигает цены.',
            'Решённая задача выбывает: её доли больше ничего не стоят, а цены остальных растут.',
            'Когда останется одна задача, через 72 часа её доли выплачиваются. Это время на то, чтобы отменить выбывание по ошибочно опубликованному решению.',
            'Кванты игрушечные: их нельзя купить за деньги или вывести. На них покупаются реакции.',
        ],

        topTitle: 'Лучшие прогнозы',
        topEmpty: 'Пока никто не сделал прогноз. Будьте первым.',
        profit: 'прибыль',
        you: 'вы',
        benchmark: 'эталон',

        shopTitle: 'Реакции за кванты',
        shopNote: 'Купленная реакция навсегда ваша: ставьте её в чате и под решениями.',
        owned: 'Ваша',
        buyFor: 'Купить за',
        offSeason: 'Продаётся с 23 сентября по 23 октября',
        trophy: 'Трофей, не продаётся',
        never: 'Не продаётся',
        trophyHow: {
            ':n2000:': 'Достанется автору 2000-го решения на сайте',
            ':last:': 'Достанется тому, кто решит последнюю задачу',
        },
        perpetuumRefusal: 'Патентное бюро отклонило заявку: нарушает первое начало термодинамики.',
        unlocked: 'Реакция ваша',
        confirm: 'Точно?',

        notesTitle: 'Заметки демона',
        notes: [
            'Я изучил 36 недель истории решений: 13 226 задаче-недель и 512 первых решений. На неделях после 20 июля, которые я не видел при обучении, AUC 0,71.',
            'Лучше всего предсказывает, когда задачу решат, оценка времени на решение. Сложность по шкале сайта предсказывает слабее.',
            'Длинные условия решают позже: каждое стандартное отклонение длины снижает шанс решения за неделю примерно на 17%. Valter был прав.',
            'Звёздочка ∗ ничего не говорит о том, в каком порядке решат оставшиеся задачи.',
            'Почти решённый раздел затягивает свои хвосты, а решения в той же главе за последние две недели ускоряют соседние задачи.',
            'По 8 000 прогонам одна задача останется примерно через 261 день, скорее всего между мартом и октябрём 2027 года.',
            'Мои 800 ħ разложены по десяти задачам пропорционально шансам: 7.2.13, 6.6.27, 14.3.27, 7.2.12, 14.3.8, 5.8.9, 14.3.26, 5.3.11, 7.2.14, 8.2.32. Задача 7.2.11 у меня тринадцатая.',
        ],

        amountEggs: {
            137: 'α⁻¹ ≈ 137. Постоянная тонкой структуры одобряет',
            273: '273 K это 0 °C. Холоднокровная ставка',
            666: 'Число демона. Лапласа, разумеется',
            1836: 'mₚ/mₑ ≈ 1836. Протон доволен',
            2023: 'Ровно столько задач в задачнике, и в этом году родился сайт',
        },
        // 5.8.9 was declared the most horrifying problem in the book on 15 Sep, so that nobody would
        // solve it and spoil a bet; its "followers", it was explained, do not like to lose.
        problemEggs: {
            '5.8.9': 'Осторожно: у этой задачи есть последователи, и они не любят проигрывать. Не злите их.',
        },
        collapse: 'Коллапс волновой функции',
        birthday: 'Savchenko Solutions 3 года',

        errors: {
            auth: 'Сначала войдите',
            amount: 'Введите целое число квантов',
            insufficient: 'Не хватает квантов',
            closed: 'Эта задача уже не в игре',
            not_held: 'У вас нет этих долей',
            shares: 'Не то число долей',
            side: 'Что-то пошло не так',
            owned: 'Эта реакция уже ваша',
            off_season: 'Сейчас не продаётся',
            never: 'Не продаётся',
            trophy: 'Трофей не продаётся',
            rate_limited: 'Слишком часто, подождите минуту',
            cross_site: 'Запрос пришёл не с сайта',
            not_open: 'Рынок закрыт',
            server: 'Не получилось, попробуйте ещё раз',
        },

        card: {
            open: 'Открыть',
            leaders: 'Лучшие прогнозы',
            nobody: 'Прогнозов пока нет',
        },

        notify: {
            chatBetTitle: 'Ваша ставка из чата учтена',
            chatBet: (problem, amount) => `${problem}: ${amount} ħ в «Последней задаче», как вы написали в чате. Если не хотите, отмените в приложении: кванты вернутся полностью.`,
            solvedTitle: (problem) => `${problem} решена и выбывает`,
            solved: (problem, who) => `${who ? `Решение опубликовал(а) ${who}. ` : ''}Ваши доли этой задачи больше не в игре.`,
            decidedTitle: (problem) => `Осталась одна задача: ${problem}`,
            decided: 'Если за 72 часа ничего не изменится, её доли будут выплачены.',
            payoutTitle: (amount) => `Выплата: +${amount} ħ`,
            payout: (problem) => `${problem} оказалась последней задачей. Кванты на балансе.`,
            trophyTitle: (name) => `Трофей: ${name}`,
            trophyN2000: 'Вы опубликовали 2000-е решение на сайте. Эта реакция теперь только ваша.',
            trophyLast: 'Вы решили последнюю задачу Савченко на сайте. Эта реакция теперь только ваша.',
            announceTitle: 'Последняя задача: прогнозы открыты',
            announce: 'Какая задача будет решена последней? У каждого 1 000 ħ на прогнозы.',
        },
    },

    en: {
        appName: 'The Last Problem',
        appKind: 'mini app',
        host: "Laplace's demon",
        question: 'Which problem will be solved last?',
        close: 'Close',
        openInChat: 'Open in chat',
        tabs: { market: 'Predict', top: 'Leaders', shop: 'Reactions' },

        welcomeTitle: 'Your starting balance',
        welcomeClaim: 'Claim',
        welcomeNote: 'Quanta are play money: they cannot be bought or cashed out. Win them with predictions and spend them on chat reactions.',
        signIn: 'Sign in to get 1,000 ħ and make predictions',
        signInButton: 'Sign in',

        balance: 'Balance',
        groundState: 'Ground state · ½ħω',
        opened: 'Opened on 15 September by emixter\'s question in the chat',
        decidedBanner: 'One problem left: {problem}. If nothing changes within 72 hours, its shares pay out.',
        resolvedBanner: 'The last one was {problem}. Shares are paid; thank you to everyone who solved and predicted.',
        traders: ['trader', 'traders'],
        problemsLeft: ['problem left', 'problems left'],
        chance: 'chance',
        payout: 'payout',
        buy: 'Buy',
        sell: 'Sell',
        sellAll: 'Sell all',
        sellHalf: 'Sell half',
        bought: 'Bought',
        sold: 'Sold',
        amount: 'Amount',
        max: 'Max',
        confirmBuy: 'Buy for',
        youGet: 'You get',
        shares: ['share', 'shares'],
        ifLast: 'if it is the last one solved',
        yourPositions: 'Your predictions',
        worthNow: 'worth now',
        spent: 'spent',
        fromChat: 'from chat',
        cancelChatBet: 'Cancel and refund',
        solvedList: 'Solved since the market opened',
        solvedBy: 'solution by',
        statement: 'Statement',
        recent: 'Latest',
        feedBuy: 'bought',
        feedSell: 'sold',
        feedSolved: 'solved, out of the market',
        demonName: "Laplace's demon",
        rulesTitle: 'Rules',
        rules: [
            'The market opened on 15 September, when emixter asked in the chat which problem will be solved last. It covers the problems unsolved at that moment.',
            'A problem counts as solved when its solution appears on the site in either language. The empty template from "Add a problem" does not count.',
            'A problem\'s price is the chance the market gives it. One share costs that many quanta, and pays 1 ħ if the problem turns out to be the last one solved. The multiplier shows how much a bet grows if it wins.',
            'You can buy and sell at any moment. The market itself takes the other side of every trade (LMSR, b = 1000), so every trade moves the prices.',
            'A solved problem is out: its shares are worth nothing, and every other price goes up.',
            'When one problem is left, its shares pay out after 72 hours. That window is for undoing an elimination caused by a mistaken post.',
            'Quanta are play money: they cannot be bought for money or cashed out. They buy reactions.',
        ],

        topTitle: 'Best predictions',
        topEmpty: 'No predictions yet. Be the first.',
        profit: 'profit',
        you: 'you',
        benchmark: 'benchmark',

        shopTitle: 'Reactions for quanta',
        shopNote: 'A reaction you buy is yours for good: use it in the chat and under solutions.',
        owned: 'Yours',
        buyFor: 'Buy for',
        offSeason: 'On sale from 23 September to 23 October',
        trophy: 'Trophy, not for sale',
        never: 'Not for sale',
        trophyHow: {
            ':n2000:': 'Goes to the author of the 2000th solution on the site',
            ':last:': 'Goes to whoever solves the last problem',
        },
        perpetuumRefusal: 'The patent office rejected the application: it violates the first law of thermodynamics.',
        unlocked: 'The reaction is yours',
        confirm: 'Sure?',

        notesTitle: "The demon's notes",
        notes: [
            'I studied 36 weeks of solving history: 13,226 problem-weeks and 512 first solutions. On the weeks after 20 July, which I did not see while learning, the AUC is 0.71.',
            'The best single predictor of when a problem gets solved is the estimated solving time. The site\'s difficulty score predicts less well.',
            'Long statements get solved later: each standard deviation of length lowers the weekly chance by about 17%. Valter was right.',
            'The asterisk ∗ says nothing about the order in which the remaining problems get solved.',
            'A nearly finished section pulls in its stragglers, and solutions in the same chapter over the last two weeks speed up the neighbours.',
            'Across 8,000 simulations one problem is left in about 261 days, most likely between March and October 2027.',
            'My 800 ħ are spread over ten problems in proportion to their chances: 7.2.13, 6.6.27, 14.3.27, 7.2.12, 14.3.8, 5.8.9, 14.3.26, 5.3.11, 7.2.14, 8.2.32. I rank 7.2.11 thirteenth.',
        ],

        amountEggs: {
            137: 'α⁻¹ ≈ 137. The fine-structure constant approves',
            273: '273 K is 0 °C. A cold-blooded bet',
            666: "The demon's number. Laplace's, of course",
            1836: 'mₚ/mₑ ≈ 1836. The proton is pleased',
            2023: 'Exactly the number of problems in the book, and the year the site was born',
        },
        problemEggs: {
            '5.8.9': 'Careful: this problem has followers, and they do not like to lose. Do not anger them.',
        },
        collapse: 'Wave function collapse',
        birthday: 'Savchenko Solutions turns 3',

        errors: {
            auth: 'Sign in first',
            amount: 'Enter a whole number of quanta',
            insufficient: 'Not enough quanta',
            closed: 'This problem is out of the market',
            not_held: 'You do not hold these shares',
            shares: 'That is not a valid number of shares',
            side: 'Something went wrong',
            owned: 'This reaction is already yours',
            off_season: 'Not on sale right now',
            never: 'Not for sale',
            trophy: 'Trophies are not for sale',
            rate_limited: 'Too fast, wait a minute',
            cross_site: 'That request did not come from the site',
            not_open: 'The market is closed',
            server: 'That did not work, try again',
        },

        card: {
            open: 'Open',
            leaders: 'Best predictions',
            nobody: 'No predictions yet',
        },

        notify: {
            chatBetTitle: 'Your bet from the chat is in',
            chatBet: (problem, amount) => `${problem}: ${amount} ħ in The Last Problem, as you wrote in the chat. If you would rather not, cancel it in the app and get every quantum back.`,
            solvedTitle: (problem) => `${problem} is solved and out`,
            solved: (problem, who) => `${who ? `Solution posted by ${who}. ` : ''}Your shares in this problem are out of the game.`,
            decidedTitle: (problem) => `One problem left: ${problem}`,
            decided: 'If nothing changes within 72 hours, its shares pay out.',
            payoutTitle: (amount) => `Payout: +${amount} ħ`,
            payout: (problem) => `${problem} was the last problem solved. The quanta are in your balance.`,
            trophyTitle: (name) => `Trophy: ${name}`,
            trophyN2000: 'You posted the 2000th solution on the site. This reaction is now yours alone.',
            trophyLast: 'You solved the last Savchenko problem on the site. This reaction is now yours alone.',
            announceTitle: 'The Last Problem: predictions are open',
            announce: 'Which problem will be solved last? Everyone has 1,000 ħ to predict with.',
        },
    },
};

function getCopy(lang) {
    return lang === 'ru' ? COPY.ru : COPY.en;
}

/* The part the browser needs, as plain JSON (no functions). */
function clientCopy(lang) {
    const c = getCopy(lang);
    const out = {};
    for (const [key, value] of Object.entries(c)) {
        if (key === 'notify') continue;
        out[key] = value;
    }
    return out;
}

module.exports = { COPY, getCopy, clientCopy };
