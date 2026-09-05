with open('src/db/schema.sql', 'r') as f:
    c = f.read()

c = c.replace("    CHECK (pending_count <= max_pending)\n);", "    CHECK (pending_count <= max_pending)\n);\n\nINSERT INTO global_quota (id, max_pending, pending_count) VALUES (1, 1000, 0) ON CONFLICT DO NOTHING;")

with open('src/db/schema.sql', 'w') as f:
    f.write(c)
