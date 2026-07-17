FROM docker:28-dind

ENV DOCKER_TLS_CERTDIR=""

RUN apk add --no-cache python3 bash curl git openssh-client

COPY server.py /srv/server.py
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/start.sh"]
