# Pin to the live shop (WordPress 7.1, PHP 8.3). Do not float
# wordpress:latest — a silent WP bump on a new VPS is an untested shop.
FROM wordpress:7.1-php8.3-apache

ADD --chmod=755 \
  https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions \
  /usr/local/bin/install-php-extensions

RUN install-php-extensions redis
