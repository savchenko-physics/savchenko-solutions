# Prompt 16: Final Integration + Navigation + Testing

ultrathink

Read CLAUDE.md first. Then read index.js to see all mounted routers and the current navigation templates.

This is the final cleanup prompt. Ensure all new features are properly integrated, navigation is consistent, and nothing is broken.

## Task 1: Unified Navigation

The navbar now needs to accommodate more sections. Redesign the navigation for desktop and mobile.

Desktop navbar (left to right):
- Logo + "Savchenko Solutions"
- Search bar (center)
- Nav links: "Problems" (dropdown: Savchenko, Problem Bank, Unsolved), "Learn" (dropdown: Study Guide, Study Paths, Tools), "Community" (dropdown: Discussion, Blog, Contributors, Challenges)
- Language toggle
- Notification bell (logged-in)
- User avatar dropdown (logged-in) or "Log in" (logged-out)

The dropdowns should be simple hover-activated menus (no click required). Use Bootstrap 5 dropdown with hover:

```css
.nav-item.dropdown:hover .dropdown-menu {
  display: block;
}
```

Each dropdown item: icon (16px, from Bootstrap Icons) + text + brief description in smaller gray text.

Mobile hamburger menu:
- Same groups but as collapsible sections
- "Problems", "Learn", "Community" as expandable headers
- All items visible when expanded

## Task 2: Footer Update

Update the footer to reflect all new sections:

Three columns:
1. **Problems** — Savchenko Solutions, Problem Bank, Unsolved Problems, Weekly Challenges
2. **Learn** — Study Guide, Study Paths, Tools, Blog
3. **Community** — Discussion Forum, Contributors, GitHub, Contact

Below: "© 2023-2026 Savchenko Solutions. Content licensed under CC BY-SA 4.0."

## Task 3: Home Page Final Layout

The home page should now have:

Left column (70%):
1. Progress bar (overall Savchenko completion)
2. Chapter grid (expandable, with solved/unsolved problem dots)
3. "Looking for more problems?" callout linking to /bank
4. Latest from the Blog (3 posts)

Right column (30%, sticky sidebar):
1. Challenge of the Week widget
2. Top Authors leaderboard (top 10)
3. Recent Changes (GitHub-style commit thread)

## Task 4: Cross-Linking

Add contextual links between sections:

1. On Savchenko solution pages: if the problem topic matches a bank problem topic, show "Related from Problem Bank" in sidebar
2. On bank problem pages: if the topic matches Savchenko problems, show "Related Savchenko Problems"
3. On blog posts: auto-link any #X.X.X pattern to Savchenko solutions
4. On forum posts: auto-link #X.X.X patterns and @username mentions
5. On study path pages: each problem links to its solution (Savchenko) or detail page (bank)

## Task 5: Error Handling Audit

Check every new router (blog.js, bank.js, forum.js, challenges.js, paths.js, tools.js, notifications.js) for:

1. Missing try/catch blocks around database queries
2. Missing authentication checks on protected routes
3. Missing input validation (SQL injection via unsanitized inputs)
4. Missing 404 handling for non-existent slugs/IDs
5. Missing CSRF protection on POST routes

Fix any issues found. Every POST route should:
- Check authentication (if required)
- Validate input
- Use parameterized queries
- Return proper status codes
- Handle errors gracefully

## Task 6: Package.json Scripts Update

Update package.json scripts:

```json
{
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "sandbox": "node sandbox/sandbox-app.js",
    "build:css": "node scripts/build-css.js",
    "build": "npm run build:css",
    "migrate": "node scripts/run-migrations.js"
  }
}
```

Create scripts/run-migrations.js that runs all SQL migration files in order:

```javascript
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool();
const migrationsDir = path.join(__dirname, '..', 'sql', 'migrations');

async function runMigrations() {
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  
  for (const file of files) {
    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      console.log(`  ✓ ${file} completed`);
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log(`  - ${file} skipped (already applied)`);
      } else {
        console.error(`  ✗ ${file} failed:`, err.message);
        process.exit(1);
      }
    }
  }
  
  await pool.end();
  console.log('All migrations complete.');
}

runMigrations();
```

## Task 7: README Update

Update README.md with:
- Current feature list
- Setup instructions (install deps, set env vars, run migrations, start server)
- List of all URL routes
- Contributing guidelines (how to add solutions, how to write blog posts, how to submit bank problems)

## Task 8: Smoke Test

Start the server with `node index.js` and verify these pages load without errors:
1. / (home page)
2. /en/1.1.1 (solution page)
3. /en/edit/1.1.1 (edit page)
4. /blog (blog list)
5. /bank (problem bank)
6. /discuss (forum)
7. /compete (challenges)
8. /paths (study paths)
9. /tools (tools landing)
10. /tools/formulas
11. /tools/units
12. /tools/constants
13. /tools/latex
14. /contributors
15. /user/astrosander (profile)
16. /settings
17. /admin (as astrosander)
18. /unsolved
19. /search?q=velocity
20. /notifications

Report any pages that fail to load and fix them.

After completing all tasks, give a final summary of the entire codebase state: how many routes exist, how many database tables, how many templates, and a list of any remaining known issues.
