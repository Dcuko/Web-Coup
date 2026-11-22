@echo off
cls
echo Servidor local de teste em http://localhost:8000  (Ctrl+C para parar)
echo Em producao o site roda no GitHub Pages, este arquivo e so pra testar local.
python -m http.server 8000
