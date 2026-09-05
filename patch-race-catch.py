with open('attack_race.js', 'r') as f:
    c = f.read()

c = c.replace("const res1 = await res1Promise;", "const res1 = await res1Promise.catch(e => e);")
c = c.replace("const res2 = await res2Promise;", "const res2 = await res2Promise.catch(e => e);")

with open('attack_race.js', 'w') as f:
    f.write(c)
