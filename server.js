import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';
import cors from 'cors';


dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());


app.use(express.static(__dirname));

let pool = null;
if (process.env.DATABASE_URL) {
    console.log('[Server] DATABASE_URL funnet. Kobler til PostgreSQL...');
    pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('localhost') ? false : {
            rejectUnauthorized: false
        }
    });

    (async () => {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS wishes (
                    id SERIAL PRIMARY KEY,
                    title TEXT,
                    imdb_url TEXT UNIQUE NOT NULL,
                    type TEXT,
                    imdb_rating TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await pool.query(`ALTER TABLE wishes ALTER COLUMN title DROP NOT NULL`);
            await pool.query(`ALTER TABLE wishes ALTER COLUMN type DROP NOT NULL`);
            await pool.query(`ALTER TABLE wishes ADD COLUMN IF NOT EXISTS imdb_rating TEXT`);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS comments (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('[Server] Database-tabeller verifisert og oppdatert.');
        } catch (err) {
            console.error('[Server] Feil ved oppsett av database:', err.message);
        }
    })();
} else {
    console.log('[Server] Ingen DATABASE_URL funnet. Kjører med midlertidig minne (RAM).');
}

let databaseWishes = [];
let databaseComments = [];


function validateImdbUrl(rawUrl) {
    if (typeof rawUrl !== 'string') {
        throw new Error('Ugyldig IMDb-lenke.');
    }


    let trimmedUrl = rawUrl.trim();

    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
        trimmedUrl = 'https://' + trimmedUrl;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(trimmedUrl);
    } catch {
        throw new Error('Ugyldig IMDb-lenke. Klarte ikke å lese adressen.');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('IMDb-lenken må bruke HTTP eller HTTPS.');
    }

    const hostname = parsedUrl.hostname.toLowerCase();

    if (hostname !== 'imdb.com' && !hostname.endsWith('.imdb.com')) {
        throw new Error('Lenken må være fra en offisiell IMDb-adresse (imdb.com).');
    }

    if (!/\/title\/tt\d+/i.test(parsedUrl.pathname)) {
        throw new Error('IMDb-lenken må peke til en tittel-side, for eksempel /title/tt1234567.');
    }

    return trimmedUrl;
}

function uttrekkImdbId(imdbUrl) {
    const match = imdbUrl.match(/\/title\/(tt\d+)/i);
    return match ? match[1] : null;
}

async function fetchTitleFromOmdb(imdbId) {
    const rawKey = process.env.OMDB_API_KEY;
    if (!rawKey) throw new Error('OMDB_API_KEY mangler i .env / Render environment.');
    const cleanKey = rawKey.trim().replace(/^\[|\]$/g, '').replace(/^['"]|['"]$/g, '');
    const res = await fetch(`https://www.omdbapi.com/?i=${imdbId}&apikey=${cleanKey}`);
    if (!res.ok) {
        throw new Error(`OMDB returnerte HTTP status ${res.status} (${res.statusText})`);
    }

    const data = await res.json();
    if (data.Response === 'False') {
        throw new Error(data.Error || 'Ikke funnet');
    }
    return { title: data.Title, type: data.Type, year: data.Year, imdbRating: data.imdbRating };
}

async function getMovieDataByImdbId(imdbId) {
    let title = null;
    let type = null;
    let imdbRating = null;

    if (process.env.OMDB_API_KEY) {
        try {
            const data = await fetchTitleFromOmdb(imdbId);
            if (data) {
                title = data.title;
                type = data.type === 'movie' ? 'Film' : data.type === 'series' ? 'Serie' : data.type || null;
                imdbRating = data.imdbRating || null;
                console.log('[OMDb] Fant tittel via OMDb:', title);
            } else {
                console.log('[OMDb] Fant ikke filmen via ID.');
            }
        } catch (error) {
            console.error('[OMDb] Nettverksfeil under henting av OMDb-data:', error);
        }
    } else {
        console.warn('[OMDb] OMDB_API_KEY er ikke satt. Bruker IMDb-side som fallback for tittel.');
    }

    if (!title) {
        try {
            const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
            const res = await fetch(imdbUrl, {
                headers: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            if (res.ok) {
                const html = await res.text();

                // Match og:title regardless of attribute order
                const ogMetaMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]*>/i)
                    || html.match(/<meta[^>]+content=[^>]+property=["']og:title["'][^>]*>/i);
                if (ogMetaMatch) {
                    const contentMatch = ogMetaMatch[0].match(/content=["']([^"']+)["']/i);
                    if (contentMatch && contentMatch[1]) {
                        title = contentMatch[1].trim();
                    }
                }

                if (!title) {
                    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
                    if (titleMatch && titleMatch[1]) {
                        title = titleMatch[1].trim();
                    }
                }

                const ratingMatch = html.match(/"ratingValue"\s*:\s*"?([0-9.]+)"?/i);
                if (ratingMatch && ratingMatch[1]) {
                    imdbRating = ratingMatch[1];
                }

                if (title) console.log('[IMDb] Fant tittel via scraping:', title);
            }
        } catch (err) {
            console.error('[IMDb] Feil ved henting av IMDb-side for tittel:', err.message || err);
        }
    }

    if (!title && !type && !imdbRating) return null;
    if (!title) console.warn(`[Server] Advarsel: Klarte ikke hente tittel for IMDb-ID: ${imdbId}`);
    return { title, type, imdbRating };
}



app.get('/wishes', async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM wishes ORDER BY created_at DESC');
            return res.json(result.rows);
        } catch (err) {
            return res.status(500).json({ error: 'Kunne ikke hente fra databasen.' });
        }
    } else {
        return res.json(databaseWishes);
    }
});

app.post('/wishes', async (req, res) => {
    try {
        if (!req.body?.url) {
            throw new Error('Ingen IMDb-lenke ble sendt.');
        }
        const godkjentUrl = validateImdbUrl(req.body.url);
        const imdbId = uttrekkImdbId(godkjentUrl);
        if (!imdbId) throw new Error('Ugyldig IMDb-lenke.');
        const movieData = await getMovieDataByImdbId(imdbId);
        const title = movieData?.title || null;
        const type = movieData?.type || null;
        const imdb_rating = movieData?.imdbRating || null;
        if (pool) {
            const result = await pool.query(
                `INSERT INTO wishes (imdb_url, title, type, imdb_rating)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (imdb_url)
                 DO UPDATE SET title = EXCLUDED.title, type = EXCLUDED.type, imdb_rating = EXCLUDED.imdb_rating
                 RETURNING *`,
                [godkjentUrl, title, type, imdb_rating]
            );
            return res.status(201).json(result.rows[0]);
        } else {
            const eksisterer = databaseWishes.find(w => w.imdb_url === godkjentUrl);
            if (!eksisterer) {
                const nyttOnske = { id: Date.now(), imdb_url: godkjentUrl, title, type, imdb_rating };
                databaseWishes.unshift(nyttOnske);
                return res.status(201).json(nyttOnske);
            }
            eksisterer.title = title;
            eksisterer.type = type;
            eksisterer.imdb_rating = imdb_rating;
            return res.status(200).json(eksisterer);
        }
    } catch (err) {
        console.error('[Server] Feil i POST /wishes:', err.message);
        return res.status(400).json({ error: err.message });
    }
});

app.delete('/wishes/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        return res.status(400).json({ error: 'Ugyldig ID.' });
    }

    if (pool) {
        try {
            const result = await pool.query(
                'DELETE FROM wishes WHERE id = $1 RETURNING *',
                [id]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Ønsket ble ikke funnet.' });
            }
            return res.json({ message: 'Ønsket er slettet.', deleted: result.rows[0] });
        } catch (err) {
            console.error('[Server] Feil i DELETE /wishes/:id:', err.message);
            return res.status(500).json({ error: 'Kunne ikke slette fra databasen.' });
        }
    } else {
        const index = databaseWishes.findIndex(w => w.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Ønsket ble ikke funnet.' });
        }
        const [deleted] = databaseWishes.splice(index, 1);
        return res.json({ message: 'Ønsket er slettet.', deleted });
    }
});

app.get('/comments', async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM comments ORDER BY created_at DESC');
            return res.json(result.rows);
        } catch (err) {
            console.error('[Server] Feil i GET /comments:', err.message);
            return res.status(500).json({ error: 'Kunne ikke hente kommentarer.' });
        }
    } else {
        return res.json(databaseComments);
    }
});

app.post('/comments', async (req, res) => {
    try {
        const { name, text } = req.body;
        if (!name || !text) {
            return res.status(400).json({ error: 'Navn og kommentar er påkrevd.' });
        }
        if (typeof name !== 'string' || name.trim().length > 100) {
            return res.status(400).json({ error: 'Navn kan ikke være lengre enn 100 tegn.' });
        }
        if (typeof text !== 'string' || text.trim().length > 2000) {
            return res.status(400).json({ error: 'Kommentaren kan ikke være lengre enn 2000 tegn.' });
        }
        if (pool) {
            const result = await pool.query(
                `INSERT INTO comments (name, text)
                 VALUES ($1, $2)
                 RETURNING *`,
                [name, text]
            );
            return res.status(201).json(result.rows[0]);
        } else {
            const nyKommentar = {
                id: Date.now(),
                name,
                text,
                created_at: new Date().toISOString()
            };
            databaseComments.unshift(nyKommentar);
            return res.status(201).json(nyKommentar);
        }
    } catch (err) {
        console.error('[Server] Feil i POST /comments:', err.message);
        return res.status(500).json({ error: 'Kunne ikke lagre kommentar.' });
    }
});

app.delete('/comments/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        return res.status(400).json({ error: 'Ugyldig ID.' });
    }

    if (pool) {
        try {
            const result = await pool.query(
                'DELETE FROM comments WHERE id = $1 RETURNING *',
                [id]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Kommentaren ble ikke funnet.' });
            }
            return res.json({ message: 'Kommentaren er slettet.', deleted: result.rows[0] });
        } catch (err) {
            console.error('[Server] Feil i DELETE /comments/:id:', err.message);
            return res.status(500).json({ error: 'Kunne ikke slette kommentaren.' });
        }
    } else {
        const index = databaseComments.findIndex(c => c.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Kommentaren ble ikke funnet.' });
        }
        const [deleted] = databaseComments.splice(index, 1);
        return res.json({ message: 'Kommentaren er slettet.', deleted });
    }
});

app.listen(PORT, () => {
    console.log(`[Server] Kjører suksessfullt på port ${PORT}`);
});
