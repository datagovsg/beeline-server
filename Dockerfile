FROM node:8.9.1-alpine

WORKDIR /app

# Copy in package.json into the image and install node modules
# These layers are only rebuilt if package.json changes
COPY package.json  .

RUN apk add vips-dev fftw-dev --update-cache \
  --repository https://dl-3.alpinelinux.org/alpine/edge/testing/

RUN apk add --no-cache make gcc g++ python && \
  npm install && \
  apk del make gcc g++ python

# Copy rest of source code into image
COPY src/ src/
COPY .babelrc .

RUN npm run build && \
  npm prune --production

RUN rm -rf src

RUN mkdir logs

EXPOSE 10000
ENV PORT 10000

CMD node dist/index.js
