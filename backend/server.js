// server.js – Express backend for FilmSwipe
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');

// Create an Express app and enable CORS
const app = express();
app.use(cors());
app.use(express.json());  // Parse JSON request bodies

// MySQL connection pool setup (update with your MySQL credentials)
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',           // your MySQL username
  password: '12345678',   // your MySQL password
  database: 'FilmSwipe',  // your MySQL database name
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise();

// Helper function: get internal user ID from Firebase UID
async function getUserId(firebaseUid) {
  const [rows] = await db.query(
    'SELECT id FROM users WHERE firebase_uid = ?', [firebaseUid]
  );
  if (rows.length) {
    return rows[0].id;
  }
  // If not found, return null (user should be created at signup)
  return null;
}

// Route: Create a new user (called after Firebase signup)
app.post('/api/users', async (req, res) => {
  try {
    const { uid, email, name } = req.body;
    if (!uid || !email) {
      return res.status(400).json({ error: "Missing user information" });
    }
    // Check if the user already exists
    const [rows] = await db.query('SELECT id FROM users WHERE firebase_uid = ?', [uid]);
    if (rows.length > 0) {
      return res.status(200).json({ message: "User already exists" });
    }
    // Insert new user record into users table
    await db.query(
      'INSERT INTO users (firebase_uid, email, name) VALUES (?, ?, ?)',
      [uid, email, name || null]
    );
    res.status(201).json({ message: "User created" });
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Assuming `db` is a MySQL connection/pool that supports promise-based queries (e.g., using mysql2)
app.get('/api/movies', async (req, res) => {
  const firebaseUid = req.query.uid;
  if (!firebaseUid) {
    return res.status(400).json({ error: "Missing uid parameter" });
  }

  try {
    // 0. Resolve internal user ID from Firebase UID
    const [userRows] = await db.execute(
      'SELECT id FROM users WHERE firebase_uid = ?',
      [firebaseUid]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const userId = userRows[0].id;

    // 1. Get user activity
    const [likes] = await db.execute(
      'SELECT movie_id FROM user_likes WHERE user_id = ? AND liked = 1',
      [userId]
    );
    const [watchlist] = await db.execute(
      'SELECT movie_id FROM watchlist WHERE user_id = ?',
      [userId]
    );
    const [dislikes] = await db.execute(
      'SELECT movie_id FROM user_likes WHERE user_id = ? AND liked = 0',
      [userId]
    );

    const likedIds     = likes.map(r => r.movie_id);
    const watchlistIds = watchlist.map(r => r.movie_id);
    const dislikedIds  = dislikes.map(r => r.movie_id);

    // Combine exclusions and positive preferences
    const excludeIds  = [...new Set([...likedIds, ...watchlistIds, ...dislikedIds])];
    const positiveIds = [...new Set([...likedIds, ...watchlistIds])];

    // 2. If no positive history, fallback to random
    if (positiveIds.length === 0) {
      const excludeClause = excludeIds.length ? `WHERE id NOT IN (${excludeIds.join(',')})` : '';
      const [randomRows] = await db.execute(
        `SELECT id, title, year, genre, rating, poster_url
         FROM movies
         ${excludeClause}
         ORDER BY RAND()
         LIMIT 1`
      );
      return res.json(randomRows[0] || {});
    }

    // 3. Derive user preferences
    const idList = positiveIds.join(',');
    const [genreRows]    = await db.execute(`SELECT DISTINCT genre_id    FROM movie_genres   WHERE movie_id IN (${idList})`);
    const [actorRows]    = await db.execute(`SELECT DISTINCT actor_id    FROM movie_actors   WHERE movie_id IN (${idList})`);
    const [directorRows] = await db.execute(`SELECT DISTINCT director_id FROM movie_directors WHERE movie_id IN (${idList})`);

    const genreIds    = genreRows.map(r => r.genre_id);
    const actorIds    = actorRows.map(r => r.actor_id);
    const directorIds = directorRows.map(r => r.director_id);

    // 4. Build recommendation query for a single best match
    const genreList    = genreIds.join(',');
    const actorList    = actorIds.join(',');
    const directorList = directorIds.join(',');
    const excludeClause = excludeIds.length ? `WHERE movie_id NOT IN (${excludeIds.join(',')})` : '';

    const recommendQuery = `
      SELECT movie_id, COUNT(*) AS score
      FROM (
        SELECT movie_id FROM movie_genres   WHERE genre_id    IN (${genreList})
        UNION ALL
        SELECT movie_id FROM movie_actors   WHERE actor_id    IN (${actorList})
        UNION ALL
        SELECT movie_id FROM movie_directors WHERE director_id IN (${directorList})
      ) AS combined
      ${excludeClause}
      GROUP BY movie_id
      ORDER BY score DESC
      LIMIT 1;
    `;
    const [recs] = await db.execute(recommendQuery);

    let resultMovie;
    if (recs.length > 0) {
      // 5a. Fetch the best match
      const movieId = recs[0].movie_id;
      const [rows] = await db.execute(
        `SELECT id, title, genre, rating, poster_url
         FROM movies
         WHERE id = ?`,
        [movieId]
      );
      resultMovie = rows[0];
    } else {
      // 5b. Fallback: random recommendation excluding seen/disliked
      const excludeClauseRandom = excludeIds.length ? `WHERE id NOT IN (${excludeIds.join(',')})` : '';
      const [randomRows] = await db.execute(
        `SELECT id, title, genre, rating, poster_url
         FROM movies
         ${excludeClauseRandom}
         ORDER BY RAND()
         LIMIT 1`
      );
      resultMovie = randomRows[0];
    }

    res.json(resultMovie || {});
  } catch (err) {
    console.error("Error generating recommendation:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route: Record a swipe action (like, dislike, add to watchlist)
app.post('/api/swipe', async (req, res) => {
  try {
    const { uid, movieId, action } = req.body;
    if (!uid || !movieId || !action) {
      return res.status(400).json({ error: "uid, movieId and action are required" });
    }
    const userId = await getUserId(uid);
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }

    if (action === 'like' || action === 'dislike') {
      const likedValue = action === 'like' ? 1 : 0;
      // Insert or update the user_likes record (liked=1 for like, 0 for dislike)
      await db.query(
        `INSERT INTO user_likes (user_id, movie_id, liked) 
         VALUES (?, ?, ?) 
         ON DUPLICATE KEY UPDATE liked = VALUES(liked)`,
        [userId, movieId, likedValue]
      );
      return res.json({ message: `Recorded ${action}` });
    } 
    if (action === 'watchlist') {
      // Add to watchlist (if not already present). 'watched' defaults to 0.
      await db.query(
        'INSERT IGNORE INTO watchlist (user_id, movie_id) VALUES (?, ?)',
        [userId, movieId]
      );
      return res.json({ message: "Added to watchlist" });
    }
    // If action is none of the above:
    res.status(400).json({ error: "Invalid action" });
  } catch (err) {
    console.error("Error recording swipe:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route: Get the user's watchlist (list of movies added, including details and watched status)
app.get('/api/watchlist', async (req, res) => {
  try {
    const userUid = req.query.uid;
    if (!userUid) {
      return res.status(400).json({ error: "Missing uid parameter" });
    }
    const userId = await getUserId(userUid);
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }
    const [list] = await db.query(`
      SELECT m.id, m.title, m.genre, m.rating, m.poster_url, w.watched
      FROM watchlist w
      JOIN movies m ON w.movie_id = m.id
      WHERE w.user_id = ?;
    `, [userId]);
    res.json(list);
  } catch (err) {
    console.error("Error fetching watchlist:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route: Remove a movie from the user's watchlist
app.delete('/api/watchlist/:movieId', async (req, res) => {
  try {
    const userUid = req.query.uid;
    const movieId = req.params.movieId;
    if (!userUid || !movieId) {
      return res.status(400).json({ error: "Missing uid or movieId" });
    }
    const userId = await getUserId(userUid);
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }
    await db.query('DELETE FROM watchlist WHERE user_id = ? AND movie_id = ?', [userId, movieId]);
    res.json({ message: "Removed from watchlist" });
  } catch (err) {
    console.error("Error removing watchlist item:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Route: Mark a watchlist movie as watched
// New: toggles watched on or off
app.put('/api/watchlist/:movieId', async (req, res) => {
  try {
    const movieId = req.params.movieId;
    const userUid = req.body.uid || req.query.uid;
    if (!userUid || !movieId) {
      return res.status(400).json({ error: "Missing uid or movieId" });
    }
    const userId = await getUserId(userUid);
    if (!userId) {
      return res.status(404).json({ error: "User not found" });
    }
    // Read the flag from the request body (default to 0)
    const watched = req.body.watched ? 1 : 0;
    await db.query(
      'UPDATE watchlist SET watched = ? WHERE user_id = ? AND movie_id = ?',
      [watched, userId, movieId]
    );
    res.json({ message: `Set watched=${watched}` });
  } catch (err) {
    console.error("Error toggling watched:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FilmSwipe API server is running on port ${PORT}`);
});
