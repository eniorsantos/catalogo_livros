# Especificação do Projeto — Catálogo de Livros

**Versão:** 2.1 · **Stack:** Node.js 18+ · Express 4 · SQLite (better-sqlite3) · PostgreSQL (pg) · HTML/CSS/JS puro

---

## 1. Visão geral

Serviço web para catalogar livros pessoais. Cada usuário tem sua própria conta e sua coleção. Os dados podem ficar em um banco **local** (SQLite), em um banco **na nuvem** (PostgreSQL) ou nos **dois ao mesmo tempo** (modo híbrido, com sincronização manual). O frontend é uma página única servida pelo próprio backend.

### 1.1 Objetivos
- CRUD completo de livros, com busca, filtro e capa.
- Isolamento total dos dados por usuário.
- Portabilidade: o mesmo código roda com SQLite ou PostgreSQL, sem mudanças.
- Deploy simples (Docker, Render, Fly.io).

### 1.2 Fora do escopo (v2.0)
Recuperação de senha, confirmação de e-mail, compartilhamento de coleções, empréstimos, leitura de código de barras pela câmera, sincronização automática em segundo plano, internacionalização (a interface está em pt-BR).

---

## 2. Arquitetura

```
┌─────────────┐   HTTP/JSON    ┌──────────────────────────┐
│  Navegador  │ ─────────────► │  Express (server.js)     │
│ public/     │ ◄───────────── │  auth · validação · API  │
│ index.html  │  cookie JWT    └────────────┬─────────────┘
└─────────────┘                             │
                                ┌───────────▼─────────────┐        ┌──────────────┐
                                │  Camada de dados (db.js)│ ─────► │ Open Library │
                                │  drivers + sync         │  (ISBN)│ (HTTPS)      │
                                └──────┬───────────┬──────┘        └──────────────┘
                                 ┌─────▼────┐ ┌────▼──────────┐
                                 │ SQLite   │ │ PostgreSQL    │
                                 │ (local)  │ │ (nuvem)       │
                                 └──────────┘ └───────────────┘
```

### 2.1 Estrutura de arquivos
| Arquivo | Responsabilidade |
|---|---|
| `server.js` | Rotas HTTP, autenticação, validação, integração com a Open Library |
| `db.js` | Drivers SQLite/PostgreSQL, esquema e migrações, operações de dados, sincronização |
| `public/index.html` | Interface completa (HTML + CSS + JS em um arquivo) |
| `Dockerfile`, `.dockerignore` | Imagem de contêiner |
| `render.yaml`, `fly.toml` | Configuração de deploy |
| `.env.example` | Modelo de variáveis de ambiente |
| `README.md` | Guia de uso rápido |

### 2.2 Modos de banco (`DB_MODE`)
| Modo | Drivers ativos | Leitura | Escrita |
|---|---|---|---|
| `local` (padrão) | SQLite | SQLite | SQLite |
| `cloud` | PostgreSQL | PostgreSQL | PostgreSQL |
| `hybrid` | SQLite + PostgreSQL | SQLite | Nos dois, em sequência (local primeiro) |

O primeiro driver da lista é o **primário** (usado em todas as leituras). Placeholders `?` são convertidos para `$1, $2…` no driver PostgreSQL, e o SQL usado é compatível com os dois bancos (`ON CONFLICT … DO UPDATE`, `LIKE`, `COALESCE`).

### 2.3 Inicialização
1. `db.js` cria os drivers conforme `DB_MODE`. Em `cloud` ou `hybrid`, a ausência de `DATABASE_URL` aborta a inicialização.
2. A promessa `db.ready` cria as tabelas (`CREATE TABLE IF NOT EXISTS`) e aplica as migrações (`ALTER TABLE … ADD COLUMN`, com erro ignorado se a coluna já existir) em **todos** os drivers.
3. O servidor só começa a escutar depois de `db.ready`. Se o banco falhar, o processo encerra com código 1.

---

## 3. Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | O usuário pode se cadastrar com e-mail e senha. |
| RF-02 | O usuário pode entrar (login) e sair (logout). A sessão dura 7 dias. |
| RF-03 | O usuário pode criar um livro (título e autor obrigatórios). |
| RF-04 | O usuário pode listar seus livros, ordenados do mais recente para o mais antigo. |
| RF-05 | O usuário pode buscar por título, autor ou gênero (sem diferenciar maiúsculas) e filtrar por status. |
| RF-06 | O usuário pode editar qualquer campo de um livro. |
| RF-07 | O usuário pode excluir um livro, que vai para a lixeira (exclusão lógica). |
| RF-08 | O usuário pode ver a lixeira, restaurar livros e excluí-los definitivamente. |
| RF-09 | O usuário pode enviar, trocar e remover a capa de um livro. |
| RF-10 | O usuário pode preencher o formulário a partir de um ISBN (Open Library), incluindo a capa. |
| RF-11 | Em modo híbrido, o usuário pode disparar a sincronização entre os bancos local e nuvem. |
| RF-12 | O administrador pode desativar novos cadastros (`ALLOW_REGISTER=false`). |
| RF-13 | O primeiro usuário cadastrado herda livros sem dono (criados na v1). |

## 4. Requisitos não funcionais

| ID | Requisito |
|---|---|
| RNF-01 | **Isolamento:** toda consulta de livros filtra por `user_id`. Um usuário nunca acessa dados de outro; recursos alheios respondem 404. |
| RNF-02 | **Segurança de senha:** hash bcrypt (custo 10); senha mínima de 8 caracteres. |
| RNF-03 | **Sessão:** JWT assinado (HS256) em cookie `httpOnly`, `SameSite=Lax`, `Secure` em produção. |
| RNF-04 | **Força bruta:** máximo de 10 requisições por IP a cada 15 min em `/auth/login` e `/auth/register` (memória do processo). |
| RNF-05 | **Injeção:** todo SQL usa parâmetros; o frontend escapa HTML antes de renderizar. |
| RNF-06 | **Limites:** corpo JSON de até 1 MB; campos de texto truncados em 2000 caracteres; capa de até ~700.000 caracteres (data URL). |
| RNF-07 | **Portabilidade:** mesmo código para SQLite e PostgreSQL. |
| RNF-08 | **Tema/responsividade:** interface responsiva, com tema claro/escuro automático (`prefers-color-scheme`). |
| RNF-09 | **Observabilidade:** `GET /api/health` informa modo e bancos ativos; contêiner com `HEALTHCHECK`. |

---

## 5. Modelo de dados

### 5.1 Tabela `users`
| Coluna | Tipo | Regras |
|---|---|---|
| `id` | TEXT | PK, UUID v4 |
| `email` | TEXT | Único, obrigatório, salvo em minúsculas |
| `password_hash` | TEXT | Obrigatório, hash bcrypt |
| `created_at` | TEXT | ISO 8601 (UTC) |
| `updated_at` | TEXT | ISO 8601 (UTC) |

### 5.2 Tabela `books`
| Coluna | Tipo | Regras |
|---|---|---|
| `id` | TEXT | PK, UUID v4 |
| `user_id` | TEXT | Dono do livro (referência lógica a `users.id`; nula apenas em dados da v1 antes do primeiro cadastro) |
| `title` | TEXT | Obrigatório, até 2000 caracteres |
| `author` | TEXT | Obrigatório, até 2000 caracteres |
| `isbn` | TEXT | Opcional |
| `year` | INTEGER | Opcional; inteiro entre 0 e (ano atual + 1) |
| `genre` | TEXT | Opcional |
| `status` | TEXT | `quero_ler` (padrão), `lendo` ou `lido` |
| `rating` | INTEGER | Opcional; inteiro de 1 a 5 |
| `notes` | TEXT | Opcional |
| `cover` | TEXT | Opcional; data URL `image/jpeg`, `image/png` ou `image/webp` em base64 |
| `created_at` | TEXT | ISO 8601 (UTC), imutável |
| `updated_at` | TEXT | ISO 8601 (UTC), atualizado em toda alteração, exclusão e restauração |
| `deleted_at` | TEXT | Nulo = ativo; preenchido = na lixeira |

**Decisões de modelagem**
- IDs em UUID e datas em texto ISO garantem o mesmo esquema nos dois bancos e permitem criar registros em qualquer lado sem colisão.
- A capa fica no banco (e não em disco) porque discos de plataformas como Render e Fly são efêmeros ou presos a uma máquina. A listagem **não** carrega a capa: devolve só `has_cover`, e a imagem é servida por rota própria.
- Bancos da v1 são migrados automaticamente com as colunas `user_id`, `cover` e `deleted_at`.

---

## 6. Regras de negócio

1. **Cadastro:** e-mail deve casar com `^\S+@\S+\.\S+$` e a senha ter 8+ caracteres. E-mail repetido retorna 409. Com `ALLOW_REGISTER=false`, retorna 403.
2. **Primeiro usuário:** ao criar o primeiro usuário do sistema, todos os livros com `user_id` nulo passam a pertencer a ele (em todos os bancos ativos).
3. **Edição:** só livros ativos podem ser editados. A atualização é parcial: campos ausentes mantêm o valor atual. `cover: null` ou `""` remove a capa; campo `cover` ausente a mantém.
4. **Exclusão lógica:** `DELETE /api/books/:id` define `deleted_at` e atualiza `updated_at`. Livros na lixeira não aparecem na lista normal nem podem ser editados.
5. **Restauração:** só funciona para livros na lixeira; limpa `deleted_at`.
6. **Exclusão definitiva:** só é permitida para livros que já estão na lixeira e remove a linha de todos os bancos ativos.
7. **Busca:** `q` procura (sem diferenciar maiúsculas) em título, autor e gênero; `status` filtra por igualdade; os dois se combinam com AND.
8. **Sincronização:** ver seção 9.

---

## 7. API HTTP

Base: `/api`. Formato: JSON (`Content-Type: application/json`). Erros têm o formato `{ "error": "mensagem" }`. Rotas marcadas com 🔒 exigem o cookie de sessão; sem ele respondem **401**.

### 7.1 Autenticação e saúde
| Método e rota | Corpo | Sucesso | Erros |
|---|---|---|---|
| `POST /auth/register` | `{ email, password }` | 201 `{ email }` + cookie | 400 dados inválidos · 403 cadastro desativado · 409 e-mail existente · 429 limite |
| `POST /auth/login` | `{ email, password }` | 200 `{ email }` + cookie | 401 credenciais inválidas · 429 limite |
| `POST /auth/logout` | — | 204 (limpa o cookie) | — |
| `GET /auth/me` 🔒 | — | 200 `{ email }` | 401 |
| `GET /health` | — | 200 `{ ok, mode, databases }` | — |

### 7.2 Livros 🔒
| Método e rota | Descrição | Sucesso | Erros |
|---|---|---|---|
| `GET /books?q=&status=&trash=1` | Lista os livros do usuário. `trash=1` lista a lixeira. | 200 `[Book]` | — |
| `GET /books/:id` | Detalhe de um livro | 200 `Book` | 404 |
| `POST /books` | Cria. Obrigatórios: `title`, `author`. | 201 `Book` | 400 |
| `PUT /books/:id` | Atualização parcial | 200 `Book` | 400 · 404 |
| `DELETE /books/:id` | Envia para a lixeira | 204 | 404 |
| `DELETE /books/:id?permanent=1` | Exclusão definitiva (só da lixeira) | 204 | 404 |
| `POST /books/:id/restore` | Restaura da lixeira | 200 `Book` | 404 |
| `GET /books/:id/cover` | Imagem da capa (`Cache-Control: private, max-age=86400`) | 200 imagem | 404 |

**Objeto `Book`** (resposta): `id, title, author, isbn, year, genre, status, rating, notes, created_at, updated_at, deleted_at, has_cover`. Os campos `cover` e `user_id` nunca são expostos.

**Exemplo — criar livro**
```http
POST /api/books
{ "title": "Dom Casmurro", "author": "Machado de Assis", "year": 1899,
  "status": "lido", "rating": 5, "cover": "data:image/jpeg;base64,..." }
```
```json
201 { "id": "869f1d5f-…", "title": "Dom Casmurro", "status": "lido", "has_cover": true, "deleted_at": null, "…": "…" }
```

### 7.3 ISBN 🔒
`GET /isbn/:isbn` — consulta a Open Library e devolve dados para preencher o formulário. Não grava nada.

- Aceita ISBN-10 (9 dígitos + dígito ou `X`) ou ISBN-13; espaços e hífens são ignorados.
- Resposta 200: `{ isbn, title, author, year, genre, cover }`. `author` junta os autores com vírgula; `genre` é o primeiro assunto; `cover` é uma data URL (ou `null` se não houver imagem ou ela passar de 500 KB).
- Erros: 400 ISBN inválido · 404 não encontrado · 502 Open Library indisponível. Timeout de 8 s por chamada externa.

### 7.4 Sincronização 🔒
`POST /sync` — 200 `{ toCloud, toLocal }` (quantidade de registros copiados em cada direção). Erro 400 se `DB_MODE` não for `hybrid`.

---

## 8. Autenticação e segurança

- **Sessão:** ao entrar, o servidor emite um JWT (`{ id, email }`, expira em 7 dias, assinado com `JWT_SECRET`) no cookie `token` (`httpOnly`, `SameSite=Lax`, `Secure` quando `NODE_ENV=production`, 7 dias).
- **Segredo:** fora de produção, usa `dev-secret` se `JWT_SECRET` faltar. **Em produção o servidor se recusa a iniciar** sem `JWT_SECRET` ou com o valor de exemplo `troque-isto`.
- **Proxy:** `trust proxy` = 1, para que o limitador veja o IP real atrás de Render ou Fly.
- **CSRF:** mitigado por `SameSite=Lax` e uso exclusivo de JSON nas rotas que alteram dados; não há token CSRF.
- **Mensagens de login:** a mesma mensagem ("Credenciais inválidas") é usada para e-mail inexistente e senha errada.
- **Validação de capa:** só aceita data URL `jpeg/png/webp` com base64 válido e menos de 700.000 caracteres.

---

## 9. Sincronização local ⇄ nuvem (modo híbrido)

Para cada tabela (`users` e `books`), o servidor lê todas as linhas dos dois bancos e compara por `id`:

| Situação | Ação |
|---|---|
| Existe só no local | Copia para a nuvem |
| Existe só na nuvem | Copia para o local |
| Existe nos dois, `updated_at` local mais novo | Local sobrescreve a nuvem |
| Existe nos dois, `updated_at` da nuvem mais novo | Nuvem sobrescreve o local |
| `updated_at` igual | Nada |

Como a exclusão lógica atualiza `updated_at`, ela se propaga normalmente.

**Limitações conhecidas**
- *Last-write-wins:* depende de relógios coerentes; edições concorrentes nos dois lados resultam na mais recente.
- *Exclusão definitiva* remove a linha dos dois bancos no momento da operação; se um deles estiver fora do ar, a linha pode reaparecer na próxima sincronização (não há marcador de remoção).
- *Escrita híbrida* não é transacional: se a escrita na nuvem falhar depois da local, a requisição retorna erro 500 e os bancos ficam divergentes até a próxima sincronização.
- A sincronização carrega as tabelas inteiras (incluindo capas) em memória; adequada para coleções pessoais, não para milhões de registros.

---

## 10. Frontend

Página única (`public/index.html`), sem build e sem dependências externas.

### 10.1 Telas
Identidade visual "Estante": tons de papel e terracota, títulos em fonte serifada, capas em destaque. Tema claro/escuro automático.
1. **Login/Cadastro:** cartão centralizado com e-mail e senha e botão para alternar entre entrar e criar conta. Exibido quando `GET /auth/me` retorna 401 e sempre que qualquer chamada recebe 401.
2. **Estante:** cabeçalho com marca, selo do modo de banco, e-mail do usuário e botões *Sincronizar* (só no modo híbrido), *Lixeira*, *Novo livro* e *Sair*. Abaixo, quatro indicadores (livros, lendo agora, lidos, nota média), busca arredondada e filtro por status em controle segmentado com contagem. A grade mostra capas de proporção 2:3 com selo de status; título, autor, ano e nota ficam abaixo, e as ações *Editar* e *Excluir* aparecem sobre a capa (ao passar o mouse, ou sempre em telas de toque).
3. **Capa gerada:** livros sem imagem recebem uma capa tipográfica com cor derivada do título (matiz calculado por hash), com título e autor.
4. **Formulário (modal):** ISBN com botão *Buscar*, título, autor, ano, gênero, status, nota, capa e anotações.
5. **Lixeira:** mesma grade, com ações *Restaurar* e *Apagar*; os indicadores e o botão *Novo livro* ficam ocultos.

### 10.2 Comportamentos
- A lista é carregada uma vez por visão (estante ou lixeira) e **filtrada no navegador**: busca instantânea (título, autor, gênero), filtro por status e indicadores calculados sobre todos os livros, sem chamadas extras à API.
- **Capa:** a imagem escolhida é redimensionada no navegador (lado maior de até 400 px, JPEG com qualidade 0,8) antes do envio. O campo `cover` só é enviado se houve mudança (nova imagem ou remoção).
- **ISBN:** o botão preenche os campos retornados e a capa; o usuário revisa e salva.
- Apagar definitivamente pede confirmação; mensagens de sucesso e erro aparecem em avisos temporários (*toasts*).
- A URL da capa inclui `?v=<updated_at>` para atualizar o cache do navegador após edições.

---

## 11. Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DB_MODE` | `local` | `local`, `cloud` ou `hybrid` |
| `SQLITE_FILE` | `./data/books.db` | Caminho do arquivo SQLite (a pasta é criada se não existir) |
| `DATABASE_URL` | — | String de conexão PostgreSQL (obrigatória em `cloud`/`hybrid`; SSL ativado, sem validar o certificado) |
| `JWT_SECRET` | — | Segredo da sessão (obrigatório em produção) |
| `ALLOW_REGISTER` | `true` | `false` fecha novos cadastros |
| `NODE_ENV` | — | `production` ativa cookie `Secure` e a exigência de `JWT_SECRET` |

## 12. Dependências

`express ^4.19`, `better-sqlite3 ^11.3`, `pg ^8.12`, `bcryptjs ^2.4`, `jsonwebtoken ^9.0`, `dotenv ^16.4`. Requer Node.js 18 ou superior (usa `fetch` e `AbortSignal.timeout` nativos).

## 13. Deploy

| Alvo | Arquivo | Banco recomendado | Observações |
|---|---|---|---|
| Docker | `Dockerfile` | SQLite com volume em `/app/data` ou PostgreSQL | Base `node:20-bookworm-slim`, porta 3000, `HEALTHCHECK` em `/api/health`; roda como root |
| Render | `render.yaml` | PostgreSQL (`DB_MODE=cloud`) | Disco gratuito é efêmero; `JWT_SECRET` gerado automaticamente; `DATABASE_URL` informada manualmente |
| Fly.io | `fly.toml` | SQLite em volume `data` (`DB_MODE=local`) | **Não é gratuito** (ver 13.1). Região `gru`; `auto_stop_machines` ativo; para Postgres, definir o secret `DATABASE_URL` e mudar `DB_MODE` |

### 13.1 Hospedagem gratuita (levantamento de out/2026)

> Planos gratuitos mudam com frequência. Os dados abaixo foram levantados em outubro de 2026 a partir de comparativos que citam as páginas oficiais dos provedores; confirme nas páginas de preços antes de decidir.

**Recomendação:** aplicação no **Render** (plano gratuito, sem cartão) + banco no **Neon** ou **Supabase**, com `DB_MODE=cloud`.

**Por que `cloud` e não `local`:** os planos gratuitos que rodam contêineres não oferecem disco persistente, então um arquivo SQLite seria perdido a cada reinício ou novo deploy. Por isso o `render.yaml` já define `DB_MODE=cloud`, e a `DATABASE_URL` aponta para um PostgreSQL externo. As capas ficam no próprio banco (seção 5.2), então também não dependem de disco.

#### Aplicação (backend + frontend)
| Provedor | Plano gratuito | Cartão | Limitações relevantes |
|---|---|---|---|
| **Render** (recomendado) | 750 horas de instância por mês; 512 MB de RAM, 0,1 CPU; aceita Docker | Não | Dorme após 15 min sem tráfego e leva cerca de 1 min para acordar; banda de 5 GB/mês desde abril de 2026; indicado para testes e uso pessoal |
| Railway | Crédito único de US$ 5 por 30 dias; depois, US$ 1 de crédito por mês | Não | 1 projeto, 3 serviços, até 0,5 GB de RAM por serviço, sem domínio próprio; serve apenas para algo muito pequeno |
| Koyeb | 1 serviço (512 MB, 0,1 vCPU) | Sim (retenção de US$ 29) | Plano sem cartão foi removido em fev/2026; escala a zero após 1 h sem uso |
| Oracle Cloud (Always Free) | VM Arm com 2 OCPUs e 12 GB de RAM | Sim | Não dorme, mas exige administrar a VM e instalar Docker; é comum faltar capacidade na região; instâncias ociosas podem ser recuperadas |
| Fly.io | Nenhum para novos clientes (teste de 2 h ou 7 dias) | Sim | Máquina mais barata custa cerca de US$ 2/mês; o `fly.toml` do projeto funciona, mas não é gratuito |

Opções fora do escopo do projeto: Google Cloud Run, AWS Lambda e Azure Container Apps têm franquias gratuitas que escalam a zero, mas exigem cartão e, por não terem disco persistente, também pediriam `DB_MODE=cloud`.

#### Banco de dados PostgreSQL (para `DB_MODE=cloud` ou `hybrid`)
| Provedor | Plano gratuito | Comportamento | Observação |
|---|---|---|---|
| **Neon** (recomendado) | 1 projeto, sem cartão | Suspende a computação após 5 min sem uso e volta em centenas de milissegundos | Evita a pausa longa do Supabase; o primeiro acesso após ociosidade pode ter um pequeno atraso |
| Supabase | 2 projetos, 500 MB, sem cartão | **Pausa após 1 semana sem atividade**; é preciso reativar manualmente | Os dados não são apagados na pausa, mas o catálogo fica inacessível até reativar |
| Render PostgreSQL | Gratuito | **Expira após 30 dias** | Não recomendado; o comentário correspondente no `render.yaml` deve ser lido como exceção |

A aplicação usa conexão SSL sem validar o certificado (seção 11), o que funciona com Neon e Supabase.

#### Passo a passo recomendado (Render + Neon)
1. Criar um projeto no Neon e copiar a string de conexão (`DATABASE_URL`).
2. Subir o repositório para o GitHub.
3. No Render: *New → Blueprint* e selecionar o repositório. O `render.yaml` cria o serviço com `DB_MODE=cloud` e gera `JWT_SECRET` automaticamente.
4. Informar a `DATABASE_URL` quando o Render solicitar.
5. Abrir o site, criar a conta (que herda eventuais livros sem dono) e depois definir `ALLOW_REGISTER=false`.

#### Efeitos práticos e riscos
- **Cold start:** o primeiro acesso após 15 min de inatividade demora cerca de 1 min (Render); se o Neon também estiver suspenso, soma-se um atraso pequeno na primeira consulta.
- **Sem alta disponibilidade:** os planos gratuitos não são indicados para produção; o Render descreve o plano como não destinado a esse uso.
- **Backup:** nenhum plano gratuito garante retenção. Faça `pg_dump` periódico do banco, ou use o modo `hybrid` em uma máquina própria como cópia local.
- **Limite de banda no Render:** 5 GB/mês; as capas são pequenas (até ~400 px), então o consumo tende a ser baixo em uso pessoal.
- **Mudanças de política:** os provedores já reduziram ou removeram planos gratuitos várias vezes (por exemplo, Fly.io em 2024, Koyeb em 2026, Render em abril de 2026). Mantenha o projeto portátil: o `Dockerfile` e a `DATABASE_URL` permitem trocar de provedor sem alterar o código.

Os comandos passo a passo estão no `README.md`.

---

## 14. Critérios de aceite

1. Sem login, qualquer rota `/api/books`, `/api/isbn` ou `/api/sync` responde 401.
2. Dois usuários diferentes não enxergam nem alteram livros um do outro (acesso a `:id` alheio responde 404).
3. Criar, ler, editar e excluir um livro funciona pela interface e pela API; o livro excluído some da lista e aparece na lixeira.
4. Restaurar devolve o livro à lista; excluir definitivamente o remove de vez (e só é aceito se estiver na lixeira).
5. Editar um livro sem enviar `cover` mantém a capa; enviar `cover: null` a remove.
6. Capa fora do formato ou acima do limite é rejeitada com 400.
7. `GET /api/isbn/123` responde 400; um ISBN válido e existente preenche o formulário.
8. Em `DB_MODE=hybrid`, uma gravação aparece nos dois bancos, e `POST /api/sync` copia o que estiver só em um dos lados. Em `local` ou `cloud`, `POST /api/sync` responde 400.
9. Em produção, o servidor não inicia sem `JWT_SECRET`.
10. Com `ALLOW_REGISTER=false`, `POST /auth/register` responde 403.
11. Após 10 tentativas em 15 min do mesmo IP em login/cadastro, a 11ª responde 429.

## 15. Limitações atuais e evolução sugerida

| Tema | Situação atual | Evolução sugerida |
|---|---|---|
| Recuperação de senha / e-mail | Não existe | Fluxo por e-mail com token de uso único |
| Limite de tentativas | Em memória, por processo | Armazenar em Redis/banco para múltiplas instâncias |
| Cabeçalhos de segurança | Não configurados | `helmet` e Content-Security-Policy |
| Testes automatizados | Apenas teste manual da API | Suíte com `node:test` ou Vitest + supertest |
| Paginação | Lista tudo de uma vez | `limit`/`offset` ou cursor |
| Sincronização | Manual, last-write-wins, sem marcador de remoção definitiva | Tombstones e sincronização incremental |
| Leitura de ISBN | Digitado | Leitor de código de barras via câmera |
| Exportação | Não existe | Exportar/importar CSV e JSON |
