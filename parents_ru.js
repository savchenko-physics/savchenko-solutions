// routes.js
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const {
    getMarkdownFiles
} = require('./utils');


function readCSV(filePath, column) {
    const csvData = fs.readFileSync(filePath, 'utf8');

    const lines = csvData.trim().split('\n');
    const chapterNames = [];

    for (let i = 0; i < lines.length; i++) {
        const columns = lines[i].split(',');
        chapterNames.push(columns[column].trim());
    }

    return chapterNames;
}



function ru_page(req, res) {
    const directory = __dirname;


    const MaxColumns = 3;
    const currentDirectory = path.join(directory, 'posts', 'ru');


    function columnLen(problemsNumber) {
        const ans = Array(MaxColumns).fill(Math.floor(problemsNumber / MaxColumns));
        for (let i = 0; i < problemsNumber % MaxColumns; i++) {
            ans[i]++;
        }
        return ans;
    }

    function existedFolders() {

        return fs.readdirSync(currentDirectory)
            .filter(f => fs.statSync(path.join(currentDirectory, f)).isFile() && f.includes('.'))

            .sort((a, b) => {
                const aParts = splitNumbers(a);
                const bParts = splitNumbers(b);

                for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                    const aNum = aParts[i] || 0;
                    const bNum = bParts[i] || 0;

                    if (aNum !== bNum) {
                        return aNum - bNum;
                    }
                }
                return 0;
            });
    }

    function existed_Problems(filePath, column) {
        const existedProblems = Array.from({
            length: 15
        }, () => Array.from({
            length: 15
        }, () => []));

        for (let problem of existedFolders()) {
            const [chapter, section, problemNumber] = problem.split('.').map(Number);
            existedProblems[chapter][section].push(problem.replace('.md', ''));
        }

        return existedProblems;
    }

    function splitNumbers(inputString) {
        return inputString.split('.').map(Number);
    }

    function PrimeDistribution(problemsList) {
        if (!problemsList.length) return "";

        return `
            <ul class="column">` +
            problemsList.map(problem => `
                <li><a href="/ru/${problem}">${problem}</a></li>`).join('') +
            `
            </ul>`;
    }

    function ProblemsDistribution(problemsList) {
        let problemsHtml = "";
        let val1 = 0;
        for (let i of columnLen(problemsList.length)) {
            let val2 = val1 + i;
            problemsHtml += PrimeDistribution(problemsList.slice(val1, val2));
            val1 = val2;
        }
        return problemsHtml;
    }

    let BaseHtml = `<!DOCTYPE html>
<html lang="ru">

<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="content-language" content="ru">
    <meta name="keywords" content="Решение Савченко по физике, Задачи Савченко по физике, задачи по физике, подготовка к олимпиадам по физике, Международная Физическая Олимпиада">
    <meta name="description" content=" Самая большая база данных решений «Савченко. Задачи по физике». Задачи Савченко по общей физике широко используются для подготовки к олимпиадам и являются полезным пособием, позволяющим освоения и оттачивания навыков и приемов решения компететных задач. Некоторые из этих задач послужили источником вдохновения для раздаточных материалов Яана Калды и для некоторых задач NBPhO. Вы можете найти задачи из старых статей IPhO из старых работ IPhO.">
    <meta name="author" content="Aliaksandr Melnichenka">
    <meta name="date" content="2023-10" scheme="YYYY-MM">
    <meta property="og:title" content="Решение Савченко О.Я.">
    <meta property="og:image" content="img/logo.png">
    <meta property="og:description" content="Решение задач по физике Савченко О.Я.">
    <meta name="yandex-verification" content="6cfda41f74038368">
    <title>Решение Савченко О.Я.</title>
    <link rel="stylesheet" href="../css/css-latex/style.css">
    <link rel="icon" href="../img/logo.png" type="image/png">
    <script src="../js/jquery-1.10.1.min.js"></script>
    <script async src="https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.7/MathJax.js?config=TeX-MML-AM_CHTML"></script>
    <script type="text/x-mathjax-config">
        MathJax.Hub.Config({
            extensions: ['tex2jax.js'],
            jax: ['input/TeX', 'output/HTML-CSS'],
            tex2jax: {
                inlineMath: [['$', '$'], ['$', '$']],
                processEscapes: true,
                processClass: 'tex2jax',
                ignoreClass: 'html'
            },
            showProcessingMessages: false,
            messageStyle: 'none'
        });
    </script>
</head>
<body id="top">
    <header class = "margin-main" style="text-align:center;">
       <a href="../" style="text-decoration: none;">
            <div id="logo">
                <span><img src="../img/book.png"></span><span>Savchenko Solutions</span>
            </div>
        </a>
        <p class="author">
            Solutions&nbsp;of&nbsp;Savchenko Problems&nbsp;in&nbsp;Physics <br>
            <i><b>knowledge must be free</b></i>
        </p>
        <h2 style="text-align: center; font-size: 1.8rem; margin-top: 0.8rem; margin-bottom: 0.2rem;"><a style="color: hsla(240, 100%, 33%, 1);" href="../">English solutions</a></h2>
        <h2 style="text-align: center; margin-top: 0.9rem; "><a href="../savchenko.pdf" target="_blank">Условия задач</a></h2>
        

        <p class="description">
        Сборник задач по физике под редакцией О.Я. Савченко - один из самых популярных ресурсов для подготовки к олимпиадам по физике в странах постсоветского пространства. За более чем 30 лет, прошедших с момента его первого издания, не было создано ни одного полного руководства по решению задач из него.<br>
        На этом сайте вы можете наблюдать попытку создания первого решебника этого сборника с оформлением решений <a href="about">разных авторов</a>. Всего было опубликовано 745 решений из 2,023 задач. В 2023 году был запущен проект, который активно развивается на русском и английском языках. Если хотите поучаствовать, пишите <a href="mailto:aliaksandr@melnichenka.com" target="_blank">aliaksandr@melnichenka.com</a>.
        </p>
    </header>


    <div class="pinned-container" id="pinned-container">
        <ol style="list-style-type:none; padding: 0;margin: 0;">
            <li><a href="#1">Кинематика</a></li>
            <li><a href="#2">Динамика</a></li>
            <li><a href="#3">Колебания и волны</a></li>
            <li><a href="#4">Механика жидкости</a></li>
            <li><a href="#5">Молекулярная физика</a></li>
            <li><a href="#6">Электростатика</a></li>
            <li><a href="#7">Электрическое поле</a></li>
            <li><a href="#8">Электрический ток</a></li>
            <li><a href="#9">Магнетизм</a></li>
            <li><a href="#10">Сложные поля</a></li>
            <li><a href="#11">Э/м индукция</a></li>
            <li><a href="#12">Э/м волны</a></li>
            <li><a href="#13">Оптика</a></li>
            <li><a href="#14">СТО</a></li>
        </ol>
    </div>

    <style>
        .pinned-container a {
            text-decoration: none;
            font-weight: bolder;
            font-size: 1.1rem;
        }
        .pinned-container a:hover {
            text-decoration: underline;
        }
        @media (min-width: 1024px) {
            .margin-main {
                margin-left: 50px;
                width: 100%;
            }
            .pinned-container {
                width:auto;
            }
        }
    </style>
    <script type="text/javascript">
        function checkScroll() {
            var pinnedContainer = document.getElementById('pinned-container');
            
            if (window.scrollY > 300) {
                pinnedContainer.classList.add('visible');
                pinnedContainer.classList.remove('hover-disabled');
            } else {
                pinnedContainer.classList.remove('visible');
                pinnedContainer.classList.add('hover-disabled');
            }
        }

        window.addEventListener('load', checkScroll);
        window.addEventListener('scroll', checkScroll);
    </script>
    <main>
        <article class="margin-main">`;

    const chapters = readCSV('src/ru/database/chapters.csv', 1);
    const theory = readCSV('src/ru/database/chapters.csv', 2);

    let sectionNumbers = readCSV('src/ru/database/sections.csv', 0);
    let sectionTitles = readCSV('src/ru/database/sections.csv', 1);
    let sections = sectionNumbers.map((num, index) => [num, sectionTitles[index]]);

    existedProblems = existed_Problems();

    for (let [index, chapter] of existedProblems.entries()) {
        if (!chapter.some(sublist => sublist.length)) continue;

        const chapterTitle = theory[index - 1] ?
            `

          <h2 id="${index}" style="text-align: center;">Глава ${index}. <a href="theory/${theory[index - 1]}" target="_blank">${chapters[index - 1]}</a></h2>` :
            `

          <h2 id="${index}" style="text-align: center;">Глава ${index}. ${chapters[index - 1]}</h2>`;

        BaseHtml += chapterTitle;


        for (let [index1, section] of chapter.entries()) {
            if (!section.length) continue;
            const FullName = `${index}.${index1}`;

            for (let i of sections) {
                if (i[0] === FullName) {
                    BaseHtml += `
          <h3 id="${FullName}" style="text-align: center;">§ ${i[0]}. ${i[1]}</h3>
          <div class="columns">${ProblemsDistribution(section)}
          </div>
          `;
                    break;
                }
            }
        }
    }

    BaseHtml += `
          </div>
        </article>
    </main>

    <script>
      MathJax = {
        tex: {
          inlineMath: [['$', '$'],],
        },
      }
      const typeFaceToggle = document.getElementById('typeface-toggle')
      const typeface = document.getElementById('typeface')
      typeFaceToggle.addEventListener('click', () => {
        document.body.classList.toggle('libertinus')
        typeface.textContent = document.body.classList.contains('libertinus') ? 'Libertinus' : 'Latin Modern'
      })

      const darkModeToggle = document.getElementById('dark-mode-toggle')
      darkModeToggle.addEventListener('click', () => {
        document.body.classList.toggle('latex-dark')
      })
    </script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());

      gtag('config', 'G-DDMB38YMLD');
    </script>
    <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
    <footer class="row container">
      <br>
        <p>
            <small> © <strong>Savchenko Solutions</strong>, 2023-2024 <br></small>
        </p>
        <p>
            <small>Все права принадлежат авторам. <br> Коммерческое использование материалов — с письменного разрешения авторов. <br> alex@savchenkosolutions.com <br></small>
        </p>
    </footer>
  </body>
</html>`;


    res.send(BaseHtml);
}

module.exports = {
    ru_page
};
