FROM node:10-alpine

WORKDIR /app

# Copy in package.json into the image and install node modules
# These layers are only rebuilt if package.json changes
COPY package.json  .

# Install tzdata so that we can easily get the local datetime
RUN apk update && apk add tzdata

RUN npm install

# Copy rest of source code into image
COPY data/ data/
COPY src/ src/
COPY .babelrc .

RUN npm run build && \
  npm prune --production

RUN rm -rf src

RUN mkdir logs

EXPOSE 10000
ENV PORT 10000

CMD node dist/index.js
