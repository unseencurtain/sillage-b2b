# Improved
FROM wordpress:latest

ADD --chmod=755 \
  https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions \
  /usr/local/bin/install-php-extensions

RUN install-php-extensions redis
