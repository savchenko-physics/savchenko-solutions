# Prompt 14: Notification System + User Dashboard

ultrathink

Read CLAUDE.md first. Then read prompts/database_structure.txt.

## Task 1: Notifications Database

Create sql/migrations/008_notifications.sql:

```sql
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  link VARCHAR(255),
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
```

Notification types:
- 'comment_on_solution' — someone commented on a problem you contributed to
- 'reply_to_comment' — someone replied to your comment
- 'solution_liked' — someone liked your solution
- 'new_follower' — someone followed you
- 'challenge_result' — your challenge submission was reviewed
- 'report_resolved' — a report you filed was resolved
- 'forum_reply' — someone replied to your forum topic
- 'forum_solution' — your forum post was marked as solution

## Task 2: Notification Creation Helpers

Create notifications.js module with helper functions:

```javascript
async function createNotification(userId, type, title, message, link) {
  await pool.query(
    'INSERT INTO notifications (user_id, type, title, message, link) VALUES ($1, $2, $3, $4, $5)',
    [userId, type, title, message, link]
  );
}

async function getUnreadCount(userId) {
  const result = await pool.query(
    'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
    [userId]
  );
  return parseInt(result.rows[0].count);
}

async function getNotifications(userId, limit = 20, offset = 0) {
  return pool.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [userId, limit, offset]
  );
}

async function markAsRead(notificationId, userId) {
  return pool.query(
    'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
    [notificationId, userId]
  );
}

async function markAllAsRead(userId) {
  return pool.query(
    'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
    [userId]
  );
}
```

## Task 3: Trigger Notifications

Add notification creation calls to existing endpoints:

1. When someone comments on a solution page (POST /api/solutions/:name/:lang/comments): notify all contributors of that problem
2. When someone replies to a comment: notify the parent comment author
3. When someone likes a solution: notify the primary contributor (debounce: max 1 like notification per problem per hour)
4. When someone follows a user: notify the followed user
5. When admin resolves a report: notify the reporter (if user_id is not null)
6. When someone replies to a forum topic: notify the topic author
7. When a forum post is marked as solution: notify the post author

For each: check that the notification recipient is not the action performer (don't notify yourself).

## Task 4: Notification Bell in Navbar

In the main header template, for logged-in users, add a bell icon next to the user avatar:

- Bell icon (SVG, 20px)
- If unread count > 0: red badge with count (max "99+")
- Click: opens a dropdown panel (300px wide, max-height 400px, scrollable)
- Dropdown shows:
  - "Notifications" heading + "Mark all as read" link
  - List of notifications, newest first
  - Each: icon by type, title (bold if unread), message (truncated), relative time
  - Click a notification: mark as read + navigate to the link
  - Unread: white background. Read: #f8f9fa background
  - "View all" link at bottom → /notifications

Fetch unread count on every page load via middleware (add to the existing user context middleware that already runs on every request).

API endpoints:
- GET /api/notifications — JSON list of notifications for current user
- POST /api/notifications/:id/read — mark single as read
- POST /api/notifications/read-all — mark all as read

## Task 5: Notifications Page

GET /notifications (auth required)
Template: views/notifications.ejs

Full page list of all notifications:
- Group by date (Today, Yesterday, This Week, Earlier)
- Each notification: type icon, title, message, time, link
- Unread highlighted
- "Mark all as read" button at top
- Pagination (50 per page)

## Task 6: User Dashboard Improvements

Currently /user/:username is the profile. Add a "My Activity" section visible only to the profile owner that shows:

- Starred problems list (from starred_solutions table)
- Recent forum topics and replies
- Challenge submission history
- Study path progress summary
- Notification preferences link → /settings (Privacy tab)

This section appears below the existing profile content, only when viewing your own profile.

## Task 7: Notification Preferences

In the Settings page (Privacy tab), add toggles for each notification type:
- Comments on my solutions
- Replies to my comments
- Likes on my solutions
- New followers
- Forum replies
- Challenge results

Store in user_preferences as a JSONB column 'notification_settings'. Default all to true.

Before creating a notification, check the user's preferences. Skip if that type is disabled.

Verify: notifications are created when actions happen, bell shows unread count, dropdown lists notifications, clicking navigates and marks as read, preferences control which notifications are sent, /notifications page works.
