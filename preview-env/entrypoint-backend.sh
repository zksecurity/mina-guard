#!/bin/sh
if [ -z "$MINAGUARD_VK_HASH" ] && [ -f /app/.vk-hash ]; then
  export MINAGUARD_VK_HASH=$(cat /app/.vk-hash)
fi
exec "$@"
