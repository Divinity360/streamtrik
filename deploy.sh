#!/bin/bash

# StreamTrik Deployment Script
# Server: 69.197.164.193
# User: administrator
# Domain: streamtrik.com

set -e

SERVER="administrator@69.197.164.193"
SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="streamtrik.com"
REMOTE_DIR="streamtrik"

echo "🚀 Deploying StreamTrik to $DOMAIN..."

# Package files
echo "📁 Creating deployment package..."
COPYFILE_DISABLE=1 tar -czf /tmp/streamtrik-deploy.tar.gz \
  -C "$SITE_DIR" \
  index.html \
  proxy.js \
  ecosystem.config.cjs \
  nginx-streamtrik.conf \
  robots.txt \
  llms.txt \
  manifest.webmanifest

echo "✅ Package ready"

# Upload
echo "📤 Uploading to server..."
scp /tmp/streamtrik-deploy.tar.gz $SERVER:/tmp/
rm /tmp/streamtrik-deploy.tar.gz
echo "✅ Uploaded"

# Deploy
echo "🔧 Deploying on server..."
ssh $SERVER bash << ENDSSH
  set -e
  mkdir -p ~/$REMOTE_DIR
  cd ~/$REMOTE_DIR
  tar -xzf /tmp/streamtrik-deploy.tar.gz
  rm /tmp/streamtrik-deploy.tar.gz
  echo "✅ Files extracted"

  # Start/reload proxy via PM2
  if pm2 describe streamtrik-proxy > /dev/null 2>&1; then
    pm2 reload streamtrik-proxy
  else
    pm2 start ecosystem.config.cjs
  fi
  pm2 save
  echo "✅ PM2 proxy running"
ENDSSH

# Nginx
echo "🌐 Configuring Nginx..."
ssh $SERVER "
  sudo cp ~/$REMOTE_DIR/nginx-streamtrik.conf /etc/nginx/sites-available/$DOMAIN
  sudo ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
  sudo nginx -t && sudo systemctl reload nginx
  echo '✅ Nginx configured'
"

# SSL
echo "🔒 Getting SSL certificate..."
ssh $SERVER "sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN \
  --non-interactive --agree-tos --email admin@$DOMAIN --redirect 2>&1 \
  || echo '⚠️  Certbot skipped (cert may already exist)'"

echo ""
echo "🎉 Done! Live at https://$DOMAIN"
