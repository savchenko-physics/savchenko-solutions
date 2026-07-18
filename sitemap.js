const fs = require('fs');
const path = require('path');
const { formatISO } = require('date-fns');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

const BASE_URL = 'https://savchenkosolutions.com';
const publicDir = path.join(__dirname, 'public');

const postsDirectories = [
    path.join(__dirname, 'posts', 'en'),
    path.join(__dirname, 'posts', 'ru')
];

function buildUrlset(entries) {
    const hasAlternates = entries.some(e => e.alternates && e.alternates.length);
    const urls = entries.map(e => {
        let xml = `    <url>\n      <loc>${e.loc}</loc>`;
        if (e.lastmod) xml += `\n      <lastmod>${e.lastmod}</lastmod>`;
        if (e.changefreq) xml += `\n      <changefreq>${e.changefreq}</changefreq>`;
        if (e.priority !== undefined) xml += `\n      <priority>${e.priority}</priority>`;
        if (e.alternates) {
            for (const a of e.alternates) {
                xml += `\n      <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`;
            }
        }
        xml += '\n    </url>';
        return xml;
    }).join('\n');

    const ns = hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${ns}>
${urls}
</urlset>`;
}

function writeIfChanged(filePath, content) {
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== content) {
        fs.writeFileSync(filePath, content);
    }
}

/* ------------------------------------------------------------------ */
/*  Sub-sitemap: Solutions                                             */
/* ------------------------------------------------------------------ */
function generateSolutionsSitemap() {
    // Which languages each problem exists in (so we can emit hreflang alternates).
    const byProblem = {}; // name -> { ru: mtime, en: mtime }
    postsDirectories.forEach(postsDirectory => {
        const lang = postsDirectory.includes('ru') ? 'ru' : 'en';
        fs.readdirSync(postsDirectory).forEach(file => {
            if (!file.endsWith('.md')) return;
            const name = file.replace('.md', '');
            const mtime = fs.statSync(path.join(postsDirectory, file)).mtime;
            (byProblem[name] = byProblem[name] || {})[lang] = mtime;
        });
    });

    const entries = [];
    for (const [name, langs] of Object.entries(byProblem)) {
        const present = Object.keys(langs); // e.g. ['ru'] or ['ru','en']
        const xDefaultLang = present.includes('en') ? 'en' : present[0];
        for (const lang of present) {
            const alternates = present.map(l => ({ hreflang: l, href: `${BASE_URL}/${l}/${name}` }));
            alternates.push({ hreflang: 'x-default', href: `${BASE_URL}/${xDefaultLang}/${name}` });
            entries.push({
                loc: `${BASE_URL}/${lang}/${name}`,
                lastmod: formatISO(langs[lang]),
                changefreq: 'weekly',
                priority: 0.8,
                alternates,
            });
        }
    }

    entries.sort((a, b) => new Date(b.lastmod) - new Date(a.lastmod));

    const content = buildUrlset(entries);
    writeIfChanged(path.join(publicDir, 'sitemap_solutions.xml'), content);
}

/* ------------------------------------------------------------------ */
/*  Sub-sitemap: Blog                                                  */
/* ------------------------------------------------------------------ */
async function generateBlogSitemap() {
    try {
        const { rows } = await pool.query(`
            SELECT slug, updated_at, created_at
            FROM blog_posts
            WHERE is_published = true
            ORDER BY COALESCE(updated_at, created_at) DESC
        `);

        const entries = rows.map(p => ({
            loc: `${BASE_URL}/blog/${p.slug}`,
            lastmod: formatISO(new Date(p.updated_at || p.created_at)),
            changefreq: 'monthly',
            priority: 0.7
        }));

        writeIfChanged(path.join(publicDir, 'sitemap_blog.xml'), buildUrlset(entries));
    } catch (err) {
        // Blog tables may not exist yet
    }
}

/* ------------------------------------------------------------------ */
/*  Sub-sitemap: Bank problems                                         */
/* ------------------------------------------------------------------ */
async function generateBankSitemap() {
    try {
        const { rows } = await pool.query(`
            SELECT id, updated_at, created_at
            FROM bank_problems
            ORDER BY id
        `);

        const entries = rows.map(p => ({
            loc: `${BASE_URL}/bank/problem/${p.id}`,
            lastmod: formatISO(new Date(p.updated_at || p.created_at)),
            changefreq: 'monthly',
            priority: 0.7
        }));

        writeIfChanged(path.join(publicDir, 'sitemap_bank.xml'), buildUrlset(entries));
    } catch (err) {
        // Bank tables may not exist yet
    }
}

/* ------------------------------------------------------------------ */
/*  Sub-sitemap: Forum topics                                          */
/* ------------------------------------------------------------------ */
async function generateForumSitemap() {
    try {
        const { rows } = await pool.query(`
            SELECT ft.id, ft.slug, ft.created_at, ft.last_reply_at, fc.slug AS category_slug
            FROM forum_topics ft
            JOIN forum_categories fc ON ft.category_id = fc.id
            ORDER BY COALESCE(ft.last_reply_at, ft.created_at) DESC
        `);

        const entries = rows.map(t => ({
            loc: `${BASE_URL}/discuss/${t.category_slug}/${t.id}-${t.slug}`,
            lastmod: formatISO(new Date(t.last_reply_at || t.created_at)),
            changefreq: 'weekly',
            priority: 0.5
        }));

        writeIfChanged(path.join(publicDir, 'sitemap_forum.xml'), buildUrlset(entries));
    } catch (err) {
        // Forum tables may not exist yet
    }
}

/* ------------------------------------------------------------------ */
/*  Sub-sitemap: Static / misc pages                                   */
/* ------------------------------------------------------------------ */
async function generateStaticSitemap() {
    // Date-only granularity so the file isn't rewritten every 60s with a fresh
    // timestamp (which falsely signals "homepage changed a minute ago" to crawlers).
    const now = formatISO(new Date(), { representation: 'date' });

    const entries = [
        // Home
        { loc: `${BASE_URL}/`, changefreq: 'daily', priority: 1.0, lastmod: now },
        { loc: `${BASE_URL}/en/`, changefreq: 'daily', priority: 1.0, lastmod: now },
        { loc: `${BASE_URL}/ru/`, changefreq: 'daily', priority: 1.0, lastmod: now },

        // Main sections
        { loc: `${BASE_URL}/about`, changefreq: 'monthly', priority: 0.6, lastmod: now },
        { loc: `${BASE_URL}/study-guide`, changefreq: 'monthly', priority: 0.6, lastmod: now },
        { loc: `${BASE_URL}/unsolved`, changefreq: 'weekly', priority: 0.6, lastmod: now },
        { loc: `${BASE_URL}/contributors`, changefreq: 'weekly', priority: 0.6, lastmod: now },

        // Blog index
        { loc: `${BASE_URL}/blog`, changefreq: 'weekly', priority: 0.6, lastmod: now },

        // Bank index
        { loc: `${BASE_URL}/bank`, changefreq: 'weekly', priority: 0.6, lastmod: now },

        // Forum index
        { loc: `${BASE_URL}/discuss`, changefreq: 'daily', priority: 0.6, lastmod: now },

        // Challenges
        { loc: `${BASE_URL}/compete`, changefreq: 'weekly', priority: 0.6, lastmod: now },

        // Study paths
        { loc: `${BASE_URL}/paths`, changefreq: 'monthly', priority: 0.6, lastmod: now },

        // Tools
        { loc: `${BASE_URL}/tools`, changefreq: 'monthly', priority: 0.6, lastmod: now },
        { loc: `${BASE_URL}/tools/formulas`, changefreq: 'monthly', priority: 0.6, lastmod: now },
        { loc: `${BASE_URL}/tools/units`, changefreq: 'monthly', priority: 0.6, lastmod: now },
        { loc: `${BASE_URL}/tools/constants`, changefreq: 'monthly', priority: 0.6, lastmod: now },
        { loc: `${BASE_URL}/tools/latex`, changefreq: 'monthly', priority: 0.6, lastmod: now },
    ];

    // Add published study paths
    try {
        const { rows } = await pool.query(`
            SELECT slug, updated_at, created_at
            FROM learning_paths
            WHERE is_published = true
            ORDER BY created_at DESC
        `);
        rows.forEach(p => {
            entries.push({
                loc: `${BASE_URL}/paths/${p.slug}`,
                lastmod: formatISO(new Date(p.updated_at || p.created_at)),
                changefreq: 'monthly',
                priority: 0.6
            });
        });
    } catch (err) {
        // Paths table may not exist yet
    }

    writeIfChanged(path.join(publicDir, 'sitemap_static.xml'), buildUrlset(entries));
}

/* ------------------------------------------------------------------ */
/*  Sitemap index                                                      */
/* ------------------------------------------------------------------ */
function generateSitemapIndex() {
    const sitemaps = [
        'sitemap_solutions.xml',
        'sitemap_blog.xml',
        'sitemap_bank.xml',
        'sitemap_forum.xml',
        'sitemap_static.xml'
    ];

    const entries = sitemaps
        .filter(name => fs.existsSync(path.join(publicDir, name)))
        .map(name => {
            const mtime = fs.statSync(path.join(publicDir, name)).mtime.toISOString();
            return `    <sitemap>\n      <loc>${BASE_URL}/${name}</loc>\n      <lastmod>${mtime}</lastmod>\n    </sitemap>`;
        })
        .join('\n');

    const content = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>`;

    writeIfChanged(path.join(publicDir, 'sitemap.xml'), content);
}

/* ------------------------------------------------------------------ */
/*  Main generator                                                     */
/* ------------------------------------------------------------------ */
async function generateSitemaps() {
    try {
        generateSolutionsSitemap();
        await Promise.all([
            generateBlogSitemap(),
            generateBankSitemap(),
            generateForumSitemap(),
            generateStaticSitemap()
        ]);
        generateSitemapIndex();
    } catch (err) {
        console.error('Sitemap generation error:', err.message);
    }
}

// Generate on startup and then every 60 seconds
generateSitemaps();
setInterval(generateSitemaps, 60 * 1000);
