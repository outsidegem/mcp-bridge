const { Pool } = require('pg');
const pool = new Pool({ user: 'u0_a338', host: '127.0.0.1', database: 'postgres', port: 5432 });

async function run() {
    const client = await pool.connect();
    try {
        await client.query("CREATE TABLE public.my_table (val text); INSERT INTO public.my_table VALUES ('real');");
        await client.query("CREATE TEMP TABLE my_table (val text); INSERT INTO my_table VALUES ('shadow');");
        
        await client.query("SET search_path = public");
        const res = await client.query("SELECT * FROM my_table");
        console.log("Result:", res.rows[0].val);
    } catch(e) {
        console.log("Error:", e.message);
    } finally {
        await client.query("DROP TABLE public.my_table");
        client.release();
        pool.end();
    }
}
run();
