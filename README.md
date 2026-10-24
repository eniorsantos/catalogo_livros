# Catálogo de Livros v2.3

Node.js + Express · SQLite (local) e/ou PostgreSQL (nuvem) · frontend em HTML/JS puro.

## Rodando localmente
```bash
npm install && cp .env.example .env && npm start   # http://localhost:3000
```
Crie sua conta na tela inicial. O **primeiro usuário herda** os livros criados na v1. Depois, defina `ALLOW_REGISTER=false` para fechar o cadastro.

## Recursos
- **Auth**: e-mail + senha (bcrypt), sessão em cookie httpOnly (JWT, 7 dias), rate limit no login. Cada usuário vê só seus livros.
- **Perfil**: nome de exibição (substitui e-mail no topo), alteração de senha (exige senha atual), exclusão de conta (apaga usuário + todos os livros, com dupla confirmação).
- **Capa**: upload redimensionado no navegador (400px, JPEG) e guardado no próprio banco; botão **📸 Foto** abre câmera traseira (mobile) / webcam (desktop) via `capture=environment`.
- **ISBN**: botão "Buscar" preenche dados pela Open Library; botão **📷 Escanear** lê código de barras (EAN-13/EAN-8/UPC) via **Barcode Detection API** (Chrome/Edge Android) — fallback para seletor de arquivo.
- **Exclusão lógica**: "Excluir" move para a Lixeira (`deleted_at`); dá para restaurar ou excluir definitivamente. A exclusão lógica propaga na sincronização.
- **Bancos** (`DB_MODE`): `local`, `cloud` ou `hybrid` (grava nos dois, lê do local, botão "Sincronizar").

## Docker
```bash
docker build -t book-catalog .
docker run -p 3000:3000 -v $(pwd)/data:/app/data -e JWT_SECRET=$(openssl rand -hex 32) book-catalog
```

## Deploy
**Render** (usa `render.yaml`, PostgreSQL, pois o disco gratuito é efêmero):
1. Suba o projeto para o GitHub → Render → *New* → *Blueprint*.
2. Informe `DATABASE_URL` (Neon, Supabase ou Render Postgres). `JWT_SECRET` é gerado automaticamente.

**Fly.io** (usa `fly.toml`, SQLite em volume persistente):
```bash
fly launch --no-deploy --copy-config      # ajuste o nome em fly.toml
fly volumes create data --size 1 --region gru
fly secrets set JWT_SECRET=$(openssl rand -hex 32)
fly deploy
```
Para usar Postgres no Fly: `fly secrets set DATABASE_URL=...` e troque `DB_MODE` para `cloud` ou `hybrid`.

## API (todas exigem login, exceto /auth e /health)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | Sessão |
| GET | `/api/auth/me` | Dados do usuário (`email`, `display_name`) |
| PUT | `/api/auth/display-name` | Atualiza nome de exibição |
| PUT | `/api/auth/password` | Altera senha (exige senha atual) |
| DELETE | `/api/auth/account` | Exclui conta + todos os livros |
| GET | `/api/books?q=&status=&trash=1` | Lista/busca (trash=1 lista a lixeira) |
| POST/PUT | `/api/books` · `/api/books/:id` | Cria/atualiza (`cover` = data URL ou null) |
| DELETE | `/api/books/:id` | Lixeira (`?permanent=1` exclui de vez, só da lixeira) |
| POST | `/api/books/:id/restore` | Restaura |
| GET | `/api/books/:id/cover` | Imagem da capa |
| GET | `/api/isbn/:isbn` | Consulta Open Library |
| POST | `/api/sync` | Sincroniza (modo hybrid) |

Especificação completa do projeto: veja [SPEC.md](SPEC.md).
