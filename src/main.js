const Apify = require('apify');

const { log } = Apify.utils;
const querystring = require('querystring');

const {
    validateInput,
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
        stealth = false,
        useChrome = false,
        pageLoadTimeoutSecs = 180,
        maxConcurrency = 20,
        outputAsISODate = false,
    } = input;

    // initialize request list from url sources
    const { sources, sheetTitle } = await checkAndCreateUrlSource(searchTerms, spreadsheetId, isPublic, timeRange, category, customTimeRange, geo);
    const requestList = await Apify.openRequestList('start-list', sources);

    // open request queue
    const requestQueue = await Apify.openRequestQueue();

    // open dataset and get itemCount
    const dataset = await Apify.openDataset();
    let { itemCount } = await dataset.getInfo();

    // if exists, evaluate extendOutputFunction, or throw
    checkAndEval(extendOutputFunction);

    const proxyConfig = await Apify.createProxyConfiguration({
        ...proxyConfiguration,
    });

    // crawler config
    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        maxRequestRetries: 5,
        handlePageTimeoutSecs: 240,
        maxConcurrency,
        useSessionPool: true,
        proxyConfiguration: proxyConfig,
        launchPuppeteerOptions: {
            stealth,
            useChrome,
            stealthOptions: {
                hideWebDriver: true,
            },
        },
        gotoFunction: async ({ request, page }) => {
            return page.goto(request.url, {
                timeout: pageLoadTimeoutSecs * 1000,
                waitUntil: 'networkidle2', // 'networkidle2', TODO: We have to figure this out
            });
        },
        handlePageFunction: async ({ page, request, session }) => {
            // if exists, check items limit. If limit is reached crawler will exit.
            if (maxItems) maxItemsCheck(maxItems, itemCount);

            log.info('Processing:', { url: request.url });
            const { label } = request.userData;

            if (label === 'START') {
                // const searchTerm = decodeURIComponent(request.url.split('?')[1].split('=')[1]);
                const queryStringObj = querystring.parse(request.url.split('?')[1]);
                const searchTerm = queryStringObj.q;

                const is429 = await page.evaluate(() => !!document.querySelector('div#af-error-container'));
                if (is429) {
                    session.retire();
                    throw new Error('Page got a 429 Error. Google is rate limiting us, retrying with different IP...');
                }

                // Check if data is present for current search term
                await page.waitForSelector('[widget-name=TIMESERIES]', { timeout: 120 * 1000 });
                const hasNoData = await page.evaluate(() => {
                    const widget = document.querySelector('[widget-name=TIMESERIES]');
                    return !!widget.querySelector('p.widget-error-title');
                });

                if (extendOutputFunction) {
                    await Apify.utils.puppeteer.injectJQuery(page);
                }

                // if no data, push message and return!
                if (hasNoData) {
                    const resObject = Object.create(null);
                    resObject[sheetTitle] = searchTerm;
                    resObject.message = 'The search term displays no data.';

                    const result = await applyFunction(page, extendOutputFunction);

                    await Apify.pushData({ ...resObject, ...result });

                    log.info(`The search term "${searchTerm}" displays no data.`);
                    return;
                }

                await page.waitForSelector('svg ~ div > table > tbody', { timeout: 120 * 1000 });

                const results = await page.evaluate(() => {
                    const tbody = document.querySelector('svg ~ div > table > tbody');
                    const trs = Array.from(tbody.children);

                    // results is an array of arrays which contains in pos 0 the date, pos 1 the value
                    const r = trs.map((tr) => {
                        const result = [];

                        const tds = Array.from(tr.children);
                        tds.forEach((td) => {
                            result.push(td.textContent.trim());
                        });

                        return result;
                    });

                    return r;
                });

                // Prepare object to be pushed
                const resObject = Object.create(null);
                resObject[sheetTitle] = searchTerm;

                for (const res of results) {
                    // res[0] holds the date, res[1] holds the value. The date will be the name of the column when dataset is exported to spreadsheet
                    let buf = Buffer.from(res[0]);
                    if (buf.readUInt8(0) === 0xe2) {
                        // google adds some unicode garbage to the data, chop both ends
                        buf = buf.slice(3).slice(0, -3);
                    }

                    const key = buf.toString();
                    resObject[outputAsISODate ? new Date(key).toISOString() : key] = Number(res[1]);
                }

                const result = await applyFunction(page, extendOutputFunction);

                // push, increase itemCount, log
                await Apify.pushData({ ...resObject, ...result });

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
