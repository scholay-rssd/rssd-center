#!/usr/bin/env python3
"""Synthetic-only filesystem, hardlink and path fixture for the overlay tool."""
import pathlib, subprocess, sys, tempfile, uuid
base='alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8'
tag=uuid.uuid4().hex
names=[f'rssd-overlay-fixture-{tag}:{kind}' for kind in ('old','new','candidate')]
try:
 with tempfile.TemporaryDirectory(prefix='rssd-overlay-fixture-') as tmp:
  root=pathlib.Path(tmp)
  for kind,date,content,filename in [('old','202001010000','old','old name'),('new','202101010000','new','new name')]:
   source=(f'FROM {base}\n'
    "RUN mkdir -p /app/node_modules/pkg /app/node_modules/next /app/node_modules/'dir with spaces' /app/apps/frontend/.next/server/'(app)' "
    "&& printf stable >/app/node_modules/pkg/file && ln /app/node_modules/pkg/file /app/node_modules/pkg/alias "
    "&& ln /app/node_modules/pkg/file /app/node_modules/next/alias "
    "&& printf unchanged >/app/node_modules/pkg/other && ln /app/node_modules/pkg/other /app/node_modules/pkg/other-alias "
    f"&& printf {content} > /app/apps/frontend/.next/server/'(app)'/page.js "
    f"&& printf {content} > /app/node_modules/'dir with spaces'/'{filename}' "
    f"&& touch -t {date} /app/node_modules/pkg/file /app/node_modules/pkg/other /app/apps/frontend/.next/server/'(app)'/page.js\n")
   dockerfile=root/('Dockerfile.'+kind);dockerfile.write_text(source)
   subprocess.run(['docker','build','-q','-f',str(dockerfile),'-t',names[0 if kind=='old' else 1],str(root)],check=True,stdout=subprocess.DEVNULL)
  source=pathlib.Path('.github/scripts/compare-overlay.py').read_text().replace('/tmp/center-overlay',str(root/'overlay'))
  module={'__name__':'synthetic_fixture'};exec(compile(source,'isolated-compare','exec'),module)
  module['OLD'],module['NEW'],module['CANDIDATE']=names
  sys.argv=['fixture','prepare'];module['main']()
  subprocess.run(['docker','build','-q','--network','none','-t',names[2],str(root/'overlay')],check=True,stdout=subprocess.DEVNULL)
  sys.argv=['fixture','verify'];module['main']()
finally:
 for name in reversed(names):
  subprocess.run(['docker','image','rm',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
