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



function eng_page(req, res) {
    const directory = __dirname;


    const MaxColumns = 3;
    const currentDirectory = path.join(directory, 'posts', 'en');


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
                <li><a href="/en/${problem}">${problem}</a></li>`).join('') +
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

    let BaseHtml = `
<!DOCTYPE html>
<html lang="en">
  <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="content-language" content="en">
      <meta name="keywords" content="Savchenko Problems in Physics, Savchenko solutions, physics problems, physics olympiad preparation, IPhO, Jaan Kalda">
      <meta name="description" content="The largest dataset of solutions of 'Savchenko. Problems in Physics'. Savchenko’s Problems in General Physics is widely used to prepare for olympiads and it is a useful tool to master and sharpen your skills and techniques in comptetitive problem solving. Some of these problems were a source of inspiration for Jaan Kalda’s handouts and to some NBPhO problems. You may find problems from old IPhO papers.">
      <meta name="author" content="Aliaksandr Melnichenka">
      <meta name="date" content="2023-10" scheme="YYYY-MM">
      <meta property="og:title" content="Savchenko Solutions">
      <meta property="og:image" content="img/logo.png">
      <meta property="og:description" content="A website with solutions to physics problems from Savchenko Textbook">
      <meta name="yandex-verification" content="6cfda41f74038368">
      <title>Savchenko Solutions</title>
      <link rel="stylesheet" href="css/css-latex/style.css">
      <link rel="icon" href="img/logo.png" type="image/png">
      <script src="js/jquery-1.10.1.min.js"></script>
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
    <header class="margin-main" style="text-align:center;">
        <a href="" style="text-decoration: none;">
            <div id="logo">
                <span><img src="img/book.png"></span><span>Savchenko Solutions</span>
            </div>
        </a>
        <p class="author">Solutions&nbsp;of&nbsp;Savchenko Problems&nbsp;in&nbsp;Physics <br>
            <i><b>knowledge must be free</b></i>
        </p>
        <h2 style="text-align: center;margin:0; font-size: 2.0rem;"><a href="ru">Решения на русском</a></h2>
        <h2 style="text-align: center; margin-top: 0.9rem; "><a href="en/savchenko_en.pdf" target="_blank">Problem statements</a></h2>
        <p class="description" id="description">
            The collection of problems in physics edited by O.Y. Savchenko is one of the most popular resources for preparation for physics olympiads in post-soviet countries. Some of these problems were a source of inspiration for Jaan Kalda’s handouts and to some NBPhO problems. You may find problems from old IPhO papers. For more than 30 years since its first edition, not a single complete guide to solving problems from it has been created.<br>
            On this website, you can observe a non-profit startup creating the first wizard of this collection with the design of solutions of <a href="about#team">different authors</a>. In total, 715 solutions have been published, out of 2,023 problems. In 2023, the project was launched, which is actively developing in Russian and English. If you'd like to contribute, feel free to email <a href="mailto:aliaksandr@melnichenka.com" target="_blank">aliaksandr@melnichenka.com</a>.
        </p>
    </header>
    <div class="pinned-container" id="pinned-container">
        <ol style="list-style-type:none; padding: 0;margin: 0;">
            <li><a href="#1">Kinematics</a></li>
            <li><a href="#2">Dynamics</a></li>
            <li><a href="#3">Oscillations and Waves</a></li>
            <li><a href="#4">Fluid Mechanics</a></li>
            <li><a href="#5">Molecular Physics</a></li>
            <li><a href="#6">Electrostatics</a></li>
            <li><a href="#7">Particles in an electric field</a></li>
            <li><a href="#8">Electric current</a></li>
            <li><a href="#9">Constant magnetic field</a></li>
            <li><a href="#10">Particles in complex fields</a></li>
            <li><a href="#11">Electromagnetic induction</a></li>
            <li><a href="#12">Electromagnetic waves</a></li>
            <li><a href="#13">Optics. Quantum physics</a></li>
            <li><a href="#14">Special theory of relativity</a></li>
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

    const chapters = readCSV('src/database/chapters.csv', 1);
    const theory = readCSV('src/database/chapters.csv', 2);

    let sectionNumbers = readCSV('src/database/sections.csv', 0);
    let sectionTitles = readCSV('src/database/sections.csv', 1);
    let sections = sectionNumbers.map((num, index) => [num, sectionTitles[index]]);

    existedProblems = existed_Problems();

    for (let [index, chapter] of existedProblems.entries()) {
        if (!chapter.some(sublist => sublist.length)) continue;

        const chapterTitle = theory[index - 1] ?
            `

          <h2 id="${index}" style="text-align: center;">Chapter ${index}. <a href="theory/${theory[index - 1]}" target="_blank">${chapters[index - 1]}</a></h2>` :
            `

          <h2 id="${index}" style="text-align: center;">Chapter ${index}. ${chapters[index - 1]}</h2>`;

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
            <small>All rights belong to the authors. <br> Commercial use of materials - with the written permission of the authors. <br> aliaksandr@melnichenka.com <br></small>
        </p>
    </footer>
  </body>
</html>`;


    res.send(BaseHtml);
}

module.exports = {
    eng_page
};
