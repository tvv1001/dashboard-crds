import re

with open('pages/api/_lib.ts', 'r') as f:
    content = f.read()

old_env = """const redisUrl = process.env.REDIS_URL;
const redisPassword = process.env.REDIS_PASSWORD;
const isDev = process.env.NODE_ENV === 'development';"""

new_env = """const isDev = process.env.NODE_ENV === 'development';
const redisUrl = isDev ? process.env.REDIS_URL : undefined;
const redisPassword = isDev ? process.env.REDIS_PASSWORD : undefined;"""

content = content.replace(old_env, new_env)

with open('pages/api/_lib.ts', 'w') as f:
    f.write(content)
