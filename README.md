# Pixhelf

轻量的本地照片画廊，支持 JPEG、PNG、WebP、搜索和排序。

## Docker Compose

```yaml
services:
  pixhelf:
    image: eureka6688/pixhelf:latest
    restart: unless-stopped
    ports:
      - "3002:3002"
    volumes:
      - "./pic:/data/pic:ro"
      - pixhelf-cache:/data/.pixhelf-cache

volumes:
  pixhelf-cache:
```

```bash
mkdir -p pic
docker compose up -d
```

## Docker

```bash
mkdir -p pic && docker run -d --name pixhelf --restart unless-stopped -p 3002:3002 -v "$PWD/pic:/data/pic:ro" -v pixhelf-cache:/data/.pixhelf-cache eureka6688/pixhelf:latest
```

照片放进 `./pic`，访问 <http://localhost:3002>。
