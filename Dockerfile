# 1) Сборка мини-приложения Telegram (TypeScript + React)
FROM node:22.22-alpine AS miniapp
WORKDIR /miniapp
COPY miniapp/package.json miniapp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY miniapp/ ./
RUN npx vite build --outDir /web

# 2) Бот на Python; мини-приложение раздаёт он же
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tradetrust ./tradetrust
COPY --from=miniapp /web ./tradetrust/bot/web

ENV PYTHONUNBUFFERED=1 DB_PATH=/data/bot.db
VOLUME /data
# версия для админки: коммит и время сборки (передаёт GitHub Actions)
ARG VERSION=dev
ARG BUILT_AT=
ENV APP_VERSION=$VERSION APP_BUILT_AT=$BUILT_AT
CMD ["python", "-m", "tradetrust.bot"]
