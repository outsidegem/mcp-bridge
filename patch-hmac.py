with open('attack_race.js', 'r') as f:
    c = f.read()

c = c.replace("0772782b7db5f553f1ff29dd62fb6a7b74bd5358055a40b1df6ff655c6e838ff", "d59059329c02a494d5b7e2748be82fae200fcf121110567e90f8ba1efde7a077")
with open('attack_race.js', 'w') as f:
    f.write(c)
