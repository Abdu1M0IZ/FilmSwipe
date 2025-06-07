// import_movies.js
// npm install mysql2 csv-parser

const fs    = require('fs');
const path  = require('path');
const csv   = require('csv-parser');
const mysql = require('mysql2/promise');

async function upsertAndMap(table, col, items, conn) {
  const map = new Map();
  const sql = `
    INSERT INTO \`${table}\` (\`${col}\`)
    VALUES (?)
    ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
  `;
  for (let val of items) {
    const [res] = await conn.execute(sql, [val]);
    map.set(val, res.insertId);
  }
  return map;
}

async function firstPassCollect(filePath) {
  const genres    = new Set();
  const directors = new Set();
  const actors    = new Set();

  // Still fine to do this with event handlers
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', row => {
        row.Genre.split(',').map(s=>s.trim()).filter(Boolean).forEach(g => genres.add(g));
        if (row.Director) directors.add(row.Director.trim());
        for (let key of ['Star1','Star2','Star3','Star4']) {
          const a = (row[key]||'').trim();
          if (a) actors.add(a);
        }
      })
      .on('end', () => resolve({ genres, directors, actors }))
      .on('error', reject);
  });
}

async function secondPassInsert(filePath, maps, conn) {
  const stream = fs.createReadStream(filePath).pipe(csv());

  // **HERE** we use for-await, so every `await conn.execute` finishes
  for await (const row of stream) {
    const title     = row.Series_Title.trim();
    const year      = parseInt(row.Released_Year,10) || null;
    const genreText = row.Genre.trim();
    const rating    = parseFloat(row.IMDB_Rating) || null;
    const poster    = row.Poster_Link.trim();

    // 1) movies
    const [mr] = await conn.execute(
      `INSERT INTO movies (title, year, genre, rating, poster_url)
       VALUES (?,?,?,?,?)`,
      [title, year, genreText, rating, poster]
    );
    const movieId = mr.insertId;

    // 2) genres
    for (let g of genreText.split(',').map(s=>s.trim()).filter(Boolean)) {
      await conn.execute(
        `INSERT IGNORE INTO movie_genres (movie_id, genre_id) VALUES (?,?)`,
        [movieId, maps.genres.get(g)]
      );
    }

    // 3) director
    if (row.Director) {
      await conn.execute(
        `INSERT IGNORE INTO movie_directors (movie_id, director_id) VALUES (?,?)`,
        [movieId, maps.directors.get(row.Director.trim())]
      );
    }

    // 4) actors
    for (let key of ['Star1','Star2','Star3','Star4']) {
      const a = (row[key]||'').trim();
      if (!a) continue;
      await conn.execute(
        `INSERT IGNORE INTO movie_actors (movie_id, actor_id) VALUES (?,?)`,
        [movieId, maps.actors.get(a)]
      );
    }

    console.log(`Imported: ${title} (${year})`);
  }
}

async function main() {
  const filePath = path.join(__dirname, 'imdb_top_500_DB.csv');
  const conn = await mysql.createConnection({
    host:     'localhost',
    user:     'root',
    password: '12345678',
    database: 'FilmSwipe'
  });

  console.log('Collecting unique genres, directors, actors…');
  const { genres, directors, actors } = await firstPassCollect(filePath);

  console.log('Seeding lookup tables…');
  const maps = {
    genres:    await upsertAndMap('genres',    'name',     genres,    conn),
    directors: await upsertAndMap('directors', 'name',     directors, conn),
    actors:    await upsertAndMap('actors',    'name',     actors,    conn),
  };

  console.log('Importing movies and creating relations…');
  await secondPassInsert(filePath, maps, conn);

  await conn.end();
  console.log('All done!');
}

main().catch(err => {
  console.error('Error during import:', err);
  process.exit(1);
});
