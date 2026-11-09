#!/bin/sh
# Раз в сутки (03:30 МСК): pg_dump → gzip → S3. Хранение KEEP_DAYS дней.
# Для RPO ≤ 15 мин дополнительно включите архивацию WAL (WAL-G) — см. docs/deploy.md.
apk add --no-cache aws-cli >/dev/null 2>&1
while true; do
  now=$(date -u +%H%M)
  if [ "$now" = "0030" ]; then
    f="nmk-$(date -u +%Y%m%d-%H%M).sql.gz"
    if pg_dump -h db -U postgres -d postgres --no-owner | gzip > "/tmp/$f"; then
      aws --endpoint-url "$S3_ENDPOINT" s3 cp "/tmp/$f" "s3://$S3_BUCKET/daily/$f" && echo "backup ok $f"
      aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://$S3_BUCKET/daily/" | awk '{print $4}' | sort | head -n -"$KEEP_DAYS" | \
        while read old; do aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://$S3_BUCKET/daily/$old"; done
    else
      echo "backup FAILED"
    fi
    rm -f "/tmp/$f"
    sleep 61
  fi
  sleep 30
done
