import glob
for file in glob.glob('src/**/*.ts', recursive=True):
    with open(file, 'r') as f:
        content = f.read()
    content = content.replace("} catch (e) {", "} catch (e: any) {")
    with open(file, 'w') as f:
        f.write(content)
