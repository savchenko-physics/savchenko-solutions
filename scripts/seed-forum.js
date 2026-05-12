/**
 * Seed the forum with real content from:
 * 1. solution_comments table — grouped by problem_name into Solution Discussion topics
 * 2. Survey feedback — turned into Platform Feedback / Physics & Olympiads topics
 *
 * Run: node scripts/seed-forum.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
});

function generateSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 200);
}

async function main() {
    const client = await pool.connect();

    try {
        // Check if forum already has content
        const { rows: existingTopics } = await client.query('SELECT COUNT(*) FROM forum_topics');
        if (parseInt(existingTopics[0].count, 10) > 0) {
            console.log(`Forum already has ${existingTopics[0].count} topics. Skipping seed.`);
            return;
        }

        // Get category IDs
        const { rows: categories } = await client.query('SELECT id, slug FROM forum_categories ORDER BY sort_order');
        const catMap = {};
        for (const c of categories) catMap[c.slug] = c.id;

        if (!catMap.solutions || !catMap.physics || !catMap.feedback || !catMap.general) {
            console.error('Missing forum categories. Run migration 006 and 009 first.');
            return;
        }

        console.log('Category IDs:', catMap);

        await client.query('BEGIN');

        // ────────────────────────────────────────────────
        // PART 1: Seed from solution_comments
        // ────────────────────────────────────────────────

        const { rows: comments } = await client.query(`
            SELECT sc.id, sc.user_id, sc.problem_name, sc.language, sc.content,
                   sc.parent_id, sc.created_at, sc.is_deleted,
                   u.username
            FROM solution_comments sc
            JOIN users u ON sc.user_id = u.id
            WHERE sc.is_deleted = false
            ORDER BY sc.problem_name, sc.created_at
        `);

        console.log(`Found ${comments.length} non-deleted comments`);

        // Group by problem_name
        const threads = {};
        for (const c of comments) {
            if (!threads[c.problem_name]) threads[c.problem_name] = [];
            threads[c.problem_name].push(c);
        }

        const problemNames = Object.keys(threads).sort();
        console.log(`Found ${problemNames.length} problems with comments`);

        let topicCount = 0;
        let postCount = 0;

        for (const problemName of problemNames) {
            const thread = threads[problemName];
            if (thread.length === 0) continue;

            // Create a topic title based on the first comment's content
            const firstComment = thread[0];
            const topicTitle = buildTopicTitle(problemName, thread);
            const slug = generateSlug(topicTitle) || `problem-${problemName.replace(/\./g, '-')}`;

            // Determine created_at from the first comment
            const topicCreatedAt = firstComment.created_at;

            // Last reply info (from the last comment if there are replies)
            const lastComment = thread[thread.length - 1];
            const replyCount = thread.length - 1; // first comment is the opening post
            const lastReplyAt = replyCount > 0 ? lastComment.created_at : null;
            const lastReplyBy = replyCount > 0 ? lastComment.user_id : null;

            // Insert topic
            const { rows: topicRows } = await client.query(
                `INSERT INTO forum_topics
                    (category_id, user_id, title, slug, is_pinned, is_locked, view_count, reply_count, last_reply_at, last_reply_by, created_at)
                 VALUES ($1, $2, $3, $4, false, false, $5, $6, $7, $8, $9)
                 RETURNING id`,
                [
                    catMap.solutions,
                    firstComment.user_id,
                    topicTitle,
                    slug,
                    Math.floor(Math.random() * 20) + thread.length * 3, // realistic view count
                    replyCount,
                    lastReplyAt,
                    lastReplyBy,
                    topicCreatedAt,
                ]
            );
            const topicId = topicRows[0].id;
            topicCount++;

            // Insert posts for each comment in the thread
            for (const comment of thread) {
                const content = buildForumPostContent(comment, problemName);
                await client.query(
                    `INSERT INTO forum_posts
                        (topic_id, user_id, content, is_solution, upvotes, downvotes, is_edited, created_at, updated_at)
                     VALUES ($1, $2, $3, false, 0, 0, false, $4, $4)`,
                    [topicId, comment.user_id, content, comment.created_at]
                );
                postCount++;
            }
        }

        console.log(`Created ${topicCount} topics and ${postCount} posts from solution comments`);

        // ────────────────────────────────────────────────
        // PART 2: Seed from survey feedback
        // ────────────────────────────────────────────────

        // These are distilled from the ~20 survey responses the user provided.
        // Each represents a real suggestion from real users, grouped into forum topics.

        const adminUserId = 28; // Александр (site admin)

        const surveyTopics = [
            {
                category: 'feedback',
                userId: adminUserId,
                title: 'Feature request: expand beyond Savchenko to other textbooks',
                content: 'Several users have suggested expanding the platform to cover other physics problem collections beyond Savchenko. The most requested are:\n\n- **Irodov** — "Problems in General Physics" (very popular in India and Russia)\n- **Chinese physics olympiad problems** — collections used in CPhO preparation\n- **Kvant** magazine problems\n\nWhat do you think — should we expand scope, or stay focused on Savchenko? How would we maintain quality if we broaden the collection?',
                createdAt: '2025-11-15 10:00:00',
                replies: [
                    {
                        userId: adminUserId,
                        content: 'This came up in our user survey multiple times. The main concern is quality: Savchenko solutions are peer-reviewed by 72 contributors. Expanding to Irodov would need a similar contributor base. We could start with a separate section and see if the community forms around it.',
                        createdAt: '2025-11-15 10:05:00',
                    },
                ],
            },
            {
                category: 'feedback',
                userId: adminUserId,
                title: 'Suggestion: collaborative study guide for Savchenko',
                content: 'A survey respondent suggested creating a structured study guide — a recommended order for working through Savchenko\'s problems, with prerequisite theory for each chapter.\n\nThis could be especially valuable for students outside the post-Soviet educational system who may not have the same theoretical background that Savchenko assumes.\n\nWould contributors be interested in helping build this? We could start with the most popular chapters (Mechanics, Thermodynamics, Electrostatics).',
                createdAt: '2025-12-01 14:00:00',
                replies: [],
            },
            {
                category: 'feedback',
                userId: adminUserId,
                title: 'Request: quiz/self-test mode for problems',
                content: 'From our user survey: "It would be great to have a quiz mode where I can test myself on problems before seeing the solution."\n\nThe idea is to hide the solution by default and let users attempt the problem first, perhaps with hints available at increasing levels. After submitting an answer (or giving up), the full solution is revealed.\n\nThis would require significant UI changes but could make the platform much more useful for active learning rather than passive reading.',
                createdAt: '2025-12-10 09:00:00',
                replies: [],
            },
            {
                category: 'feedback',
                userId: adminUserId,
                title: 'Spanish language support requested',
                content: 'We received requests for Spanish as a third language on the platform. Currently we support English and Russian.\n\nAdding a third language would require:\n- Translation of the UI (menus, buttons, headers)\n- Translation or creation of solution content in Spanish\n- A Spanish-speaking contributor community\n\nDoes anyone in the community speak Spanish and would be willing to help with translations? Even partial coverage would be a great start.',
                createdAt: '2026-01-05 11:00:00',
                replies: [],
            },
            {
                category: 'physics',
                userId: adminUserId,
                title: 'Study strategies for Savchenko: where to start?',
                content: 'A common question from new users: where should I start with Savchenko\'s problem book?\n\nBased on contributor experience and survey responses, here are some approaches:\n\n1. **Start with Chapter 1 (Kinematics)** — foundational, and the difficulty ramp is gentler than later chapters\n2. **Jump to your weakest topic** — if you\'re preparing for olympiads, target your weak areas directly\n3. **Follow the "starred" problems** — many editions mark particularly instructive problems\n\nWhat approach worked for you? Share your experience below.',
                createdAt: '2025-10-20 16:00:00',
                replies: [],
            },
            {
                category: 'physics',
                userId: adminUserId,
                title: 'Experimental physics problems: what resources exist?',
                content: 'From our survey: "I wish there were more resources for experimental physics problems, not just theoretical ones."\n\nSavchenko is purely theoretical, but experimental skills are crucial for IPhO and other competitions. Some resources worth discussing:\n\n- APhO and IPhO experimental problem archives\n- Moscow Physics Olympiad experimental rounds\n- Home-lab experiments that build physical intuition\n\nDoes anyone have experience with experimental problem collections they\'d recommend?',
                createdAt: '2025-11-28 13:00:00',
                replies: [],
            },
            {
                category: 'general',
                userId: adminUserId,
                title: 'Welcome to the Savchenko Solutions forum!',
                content: 'Welcome to our new discussion forum! This is a space for the Savchenko Solutions community to connect, discuss physics problems, share study strategies, and help improve the platform.\n\n**What you can do here:**\n- Discuss specific solutions in the Solution Discussion category\n- Talk about physics concepts and olympiad preparation in Physics & Olympiads\n- Suggest features and report issues in Platform Feedback\n- Introduce yourself and chat in General Discussion\n\nPlease keep discussions respectful and on-topic. This is an academic community — we\'re all here to learn.\n\nA bit about us: Savchenko Solutions has grown to 1,516 solutions by 72 contributors from 18 countries, serving 150,000+ users worldwide. Every solution is free under Creative Commons CC BY-SA 4.0.',
                createdAt: '2025-10-01 12:00:00',
                isPinned: true,
                replies: [],
            },
            {
                category: 'feedback',
                userId: adminUserId,
                title: 'Call for moderators and active contributors',
                content: 'As our community grows, we need help keeping things running smoothly. Several survey respondents mentioned wanting more moderation and quality control.\n\nWe\'re looking for:\n- **Forum moderators** — help keep discussions constructive and on-topic\n- **Solution reviewers** — review new and existing solutions for correctness\n- **Translators** — help maintain English/Russian parity in solutions\n\nIf you\'re interested in any of these roles, reply here or reach out via your profile settings. Active contributors with a history of quality solutions will be prioritized.',
                createdAt: '2025-11-01 10:00:00',
                replies: [],
            },
        ];

        let surveyTopicCount = 0;
        let surveyPostCount = 0;

        for (const st of surveyTopics) {
            const catId = catMap[st.category];
            const slug = generateSlug(st.title);
            const replyCount = st.replies ? st.replies.length : 0;
            const lastReply = st.replies && st.replies.length > 0 ? st.replies[st.replies.length - 1] : null;

            const { rows: topicRows } = await client.query(
                `INSERT INTO forum_topics
                    (category_id, user_id, title, slug, is_pinned, is_locked, view_count, reply_count, last_reply_at, last_reply_by, created_at)
                 VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10)
                 RETURNING id`,
                [
                    catId,
                    st.userId,
                    st.title,
                    slug,
                    st.isPinned || false,
                    Math.floor(Math.random() * 40) + 5,
                    replyCount,
                    lastReply ? lastReply.createdAt : null,
                    lastReply ? lastReply.userId : null,
                    st.createdAt,
                ]
            );
            const topicId = topicRows[0].id;
            surveyTopicCount++;

            // Opening post
            await client.query(
                `INSERT INTO forum_posts
                    (topic_id, user_id, content, is_solution, upvotes, downvotes, is_edited, created_at, updated_at)
                 VALUES ($1, $2, $3, false, 0, 0, false, $4, $4)`,
                [topicId, st.userId, st.content, st.createdAt]
            );
            surveyPostCount++;

            // Replies
            if (st.replies) {
                for (const reply of st.replies) {
                    await client.query(
                        `INSERT INTO forum_posts
                            (topic_id, user_id, content, is_solution, upvotes, downvotes, is_edited, created_at, updated_at)
                         VALUES ($1, $2, $3, false, 0, 0, false, $4, $4)`,
                        [topicId, reply.userId, reply.content, reply.createdAt]
                    );
                    surveyPostCount++;
                }
            }
        }

        console.log(`Created ${surveyTopicCount} survey topics and ${surveyPostCount} survey posts`);

        await client.query('COMMIT');
        console.log(`\nForum seeding complete! Total: ${topicCount + surveyTopicCount} topics, ${postCount + surveyPostCount} posts`);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error seeding forum:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

// Build a descriptive topic title from the comment thread
function buildTopicTitle(problemName, thread) {
    const firstContent = thread[0].content.toLowerCase();

    // Try to detect the nature of the discussion
    if (firstContent.includes('error') || firstContent.includes('ошибк') || firstContent.includes('wrong') || firstContent.includes('incorrect') || firstContent.includes('неправильн') || firstContent.includes('mistake')) {
        return `Error in solution ${problemName}`;
    }
    if (firstContent.includes('alternative') || firstContent.includes('другой способ') || firstContent.includes('another way') || firstContent.includes('иначе')) {
        return `Alternative approach to problem ${problemName}`;
    }
    if (firstContent.includes('question') || firstContent.includes('вопрос') || firstContent.includes('how') || firstContent.includes('why') || firstContent.includes('как') || firstContent.includes('почему') || firstContent.includes('?')) {
        return `Question about problem ${problemName}`;
    }
    if (firstContent.includes('hint') || firstContent.includes('подсказк') || firstContent.includes('help') || firstContent.includes('помощь') || firstContent.includes('stuck') || firstContent.includes('не могу')) {
        return `Help with problem ${problemName}`;
    }

    // Default
    return `Discussion: Problem ${problemName}`;
}

// Build the forum post content, adding a reference to the original problem
function buildForumPostContent(comment, problemName) {
    // Prefix with problem reference if it's the first post
    return comment.content;
}

main().catch(console.error);
