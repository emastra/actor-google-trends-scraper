const Apify = require('apify');
const { log } = Apify.utils;
const querystring = require('querystring');

const {
    validateInput,
    getProxyUrl,
    checkAndCreateUrlSource,
    maxItemsCheck,
    checkAndEval,
    applyFunction,
} = require('./utils');


Apify.main(async () => {
    const input = await Apify.getInput();
    validateInput(input);

    const {
        searchTerms,
        spreadsheetId,
        isPublic = false,
        timeRange,
        category,
        maxItems = null,
        customTimeRange = null,
        geo = null,
        extendOutputFunction = null,
        proxyConfiguration,
    } = input;

    // create proxy url(s) to be used in crawler configuration
    const proxyUrl = getProxyUrl(proxyConfiguration, true);
    const userAgent = proxyUrl ? Apify.utils.getRandomUserAgent() : undefined;

    // initialize request list from url sources
    const { sources, sheetTitle } = await checkAndCreateUrlSource(searchTerms, spreadsheetId, isPublic, timeRange, category, customTimeRange, geo);
    const requestList = await Apify.openRequestList('start-list', sources);

    // open request queue
    const requestQueue = await Apify.openRequestQueue();

    // open dataset and get itemCount
    const dataset = await Apify.openDataset();
    let { itemCount } = await dataset.getInfo();

    // if exists, evaluate extendOutputFunction
    let evaledFunc;
    if (extendOutputFunction) evaledFunc = checkAndEval(extendOutputFunction);

    // crawler config
    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        maxRequestRetries: 3,
        handlePageTimeoutSecs: 240,
        maxConcurrency: 20,
        launchPuppeteerOptions: {
            proxyUrl: proxyUrl,
            userAgent: userAgent,
            timeout: 120 * 1000,
            headless: true
        },

        gotoFunction: async ({ request, page }) => {
          return page.goto(request.url, {
            timeout: 180 * 1000,
            waitUntil: 'networkidle2'
          });
        },

        handlePageFunction: async ({ page, request, response }) => {
            // if exists, check items limit. If limit is reached crawler will exit.
            if (maxItems) maxItemsCheck(maxItems, itemCount);

            log.info('Processing:', request.url);
            const { label } = request.userData;

            //

            if (label === 'START') {
                // const searchTerm = decodeURIComponent(request.url.split('?')[1].split('=')[1]);
                const queryStringObj = querystring.parse(request.url.split('?')[1]);
                const searchTerm = queryStringObj.q;

                const is429 = await page.evaluate(() => !!document.querySelector('div#af-error-container'));
                if (is429) {
                    throw new Error('Page got a 429 Error');
                }

                // Check if data is present for current search term
                await page.waitForSelector('[widget-name=TIMESERIES]', { timeout: 60*1000 });
                const hasNoData = await page.evaluate(() => {
                    const widget = document.querySelector('[widget-name=TIMESERIES]');
                    return !!widget.querySelector('p.widget-error-title');
                });

                // if no data, push message and return!
                if (hasNoData) {
                    const resObject = Object.create(null);
                    resObject[sheetTitle] = searchTerm;
                    resObject.message = 'The search term displays no data.';

                    await Apify.pushData(resObject);

                    log.info(`The search term "${searchTerm}" displays no data.`);
                    return;
                }

                await page.waitForSelector('div[aria-label="A tabular representation of the data in the chart."]');

                const results = await page.evaluate(() => {
                    const dataDiv = document.querySelector('div[aria-label="A tabular representation of the data in the chart."]');
                    const tbody = dataDiv.querySelector('tbody');
                    const trs = Array.from(tbody.children);

                    // results is an array of arrays which contains in pos 0 the date, pos 1 the value
                    const results = trs.map((tr) => {
                        const result = [];

                        const tds = Array.from(tr.children);
                        tds.forEach((td) => {
                            result.push(td.innerText);
                        });

                        return result;
                    });

                    return results;
                });

                // Prepare object to be pushed
                const resObject = Object.create(null);
                resObject[sheetTitle] = searchTerm;

                for (const res of results) {
                    // res[0] holds the date, res[1] holds the value. The date will be the name of the column when dataset is exported to spreadsheet
                    resObject[res[0]] = Number(res[1]);
                }

                // push, increase itemCount, log
                await Apify.pushData(resObject);
                itemCount++;
                log.info(`Results for "${searchTerm}" pushed successfully.`);
            }
        },

        handleFailedRequestFunction: async ({ request }) => {
            log.warning(`Request ${request.url} failed too many times`);

            await dataset.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });

    log.info('Starting crawler.');
    await crawler.run();

    log.info('Crawler Finished.');

    if (spreadsheetId) {
        log.info(`
            You can get the results as usual,
            or download them in spreadsheet format under the 'dataset' tab of your actor run.
            More info in the actor documentation.
        `);
    }
});