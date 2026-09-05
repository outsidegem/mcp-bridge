const { Client } = require('pg');

async function check() {
    const client = new Client({ user: 'gateway_role', host: '127.0.0.1', database: 'postgres', port: 5432 });
    try {
        await client.connect();
        const res = await client.query("SELECT session_user, current_user");
        console.log("Logged in as:", res.rows[0]);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        await client.end().catch(e=>e);
    }
}
check();
