with open('attack_race.js', 'r') as f:
    c = f.read()

c = c.replace("SELECT reserve_request($2::text, $3::text, $4::text, $5::jsonb) as r", "SELECT reserve_request($1::text, $2::text, $3::text, $4::jsonb) as r")
c = c.replace("const args = ['00000000-0000-0000-0000-000000000001', 'tool1', 'race1', 'hash', '{}'];", "const args = ['tool1', 'race1', 'hash', '{}'];")
with open('attack_race.js', 'w') as f:
    f.write(c)
