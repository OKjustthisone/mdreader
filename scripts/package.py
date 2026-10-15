from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'dist/manifest.json').read_text())['version']
release = root / 'release'
release.mkdir(exist_ok=True)
archive = release / f'inkstone-markdown-reader-v{version}.zip'
with ZipFile(archive, 'w', ZIP_DEFLATED) as output:
    for file in sorted((root / 'dist').rglob('*')):
        if file.is_file():
            output.write(file, file.relative_to(root / 'dist'))
print(f'已打包：{archive}')
