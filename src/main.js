const Apify = require('apify');

const { log } = Apify.utils;

const {
    validateInput,
    checkAndCreateUrlSource,
    maxItemsCheck,
    checkAndEval,
    applyFunction,
    parseKeyAsIsoDate,
    proxyConfiguration,
} = require('./utils');

// Do not remove this patch
require('apify/build/constants').STATUS_CODES_BLOCKED = [401, 403];

Apify.main(async () => {
    /** @type {any} */
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
        pageLoadTimeoutSecs = 180,
        maxConcurrency = 10,
        outputAsISODate = false,
    } = input;

    const proxyConfig = await proxyConfiguration({
        proxyConfig: input.proxyConfiguration,
    });

    // initialize request list from url sources
    const { sources, sheetTitle } = await checkAndCreateUrlSource(
        searchTerms,
        spreadsheetId,
        isPublic,
        timeRange,
        category,
        customTimeRange,
        geo,
    );
    // open request queue
    const requestQueue = await Apify.openRequestQueue();

    await requestQueue.addRequest({
        url: 'https://trends.google.com/trends', // hot start it
        userData: {
            label: 'START',
        },
    });

    // open dataset and get itemCount
    const dataset = await Apify.openDataset();
    let { itemCount } = await dataset.getInfo();

    // if exists, evaluate extendOutputFunction, or throw
    checkAndEval(extendOutputFunction);

    // crawler config
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        maxRequestRetries: 3,
        // needs some time to enqueue all the initial requests
        handlePageTimeoutSecs: 300,
        maxConcurrency,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: maxConcurrency,
            sessionOptions: {
                maxErrorScore: 5,
            },
        },
        proxyConfiguration: proxyConfig,
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1,
        },
        persistCookiesPerSession: true,
        preNavigationHooks: [async (context, gotoOptions) => {
            gotoOptions.timeout = pageLoadTimeoutSecs * 1000;
            gotoOptions.waitUntil = 'domcontentloaded';
        }],
        postNavigationHooks: [async ({ page }) => {
            await page.bringToFront();
        }],
        handlePageFunction: async ({ page, request }) => {
            // if exists, check items limit. If limit is reached crawler will exit.
            if (maxItems && maxItemsCheck(maxItems, itemCount)) {
                return;
            }

            const is429 = await page.evaluate(() => !!document.querySelector('div#af-error-container'));
            if (is429) {
                await Apify.utils.sleep(10000);
                // eslint-disable-next-line no-throw-literal
                throw 'Page got a 429 Error. Google is baiting us to throw out the proxy but we need to stick with it...';
            }

            log.info('Processing:', { url: request.url });
            const { label } = request.userData;

            if (label === 'START') {
                for (const source of sources) {
                    await requestQueue.addRequest(source);
                }
            } else if (label === 'SEARCH') {
                if (extendOutputFunction) {
                    await Apify.utils.puppeteer.injectJQuery(page);
                }
                // const searchTerm = decodeURIComponent(request.url.split('?')[1].split('=')[1]);
                const queryStringObj = new URL(request.url);
                const searchTerm = queryStringObj.searchParams.get('q');
                const terms = [...(searchTerm?.split(','))];

                // The data are loading as well as the empty results error
                // So we race between them so we don't wait unecessarily

                // Returns false value if the empty selector is found
                const waitForEmptyDataSelector = async () => {
                    await page.waitForSelector('[widget-name=TIMESERIES]', { timeout: 30000 });
                    await page.waitForFunction(async () => {
                        const widget = document.querySelector('[widget-name=TIMESERIES]');
                        return !!widget?.querySelector('p.widget-error-title');
                    }, { timeout: 120 * 1000 });
                    return false;
                };

                // Returns truhly value if the data selector is found
                const waitForDataSelector = page.waitForSelector('svg ~ div > table > tbody tr', { timeout: 30000 });

                // Evaluates either to boolean (false if empty data) or a truthly selector
                const hasData = await Promise.race([
                    waitForDataSelector,
                    waitForEmptyDataSelector(),
                ]);

                // if no data, push message and return!
                if (!hasData) {
                    const resObject = Object.create(null);
                    resObject[sheetTitle] = searchTerm;
                    resObject.message = 'The search term displays no data.';

                    const result = await applyFunction(page, extendOutputFunction);

                    await Apify.pushData({ ...resObject, ...result });

                    log.info(`The search term "${searchTerm}" displays no data.`);
                    await Apify.utils.puppeteer.saveSnapshot(page, {
                        key: `NO-DATA-${searchTerm.replace(/[^a-zA-Z0-9-_]/g, '-')}`,
                        saveHtml: false,
                    });
                    return;
                }

                /**
                 * @type {Array<[string, string[]]>}
                 */
                const results = await page.evaluate(() => {
                    const trs = [...document.querySelectorAll('svg ~ div > table > tbody tr')].filter((el) => !el.closest('.hiddenDiv,bar-chart'));

                    // results is an array of arrays which contains in pos 0 the date, pos 1 the value
                    return trs.map((tr) => {
                        const result = [];

                        const tds = Array.from(tr.children);
                        /** @type {string[]} */
                        const values = [];

                        result.push(tds[0].textContent.trim());

                        tds.slice(1).forEach((td) => {
                            values.push(td.textContent.trim());
                        });

                        result.push(values);

                        return result;
                    });
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
                    // same day keys are missing the year
                    resObject[outputAsISODate ? parseKeyAsIsoDate(key) : key] = terms.map((_, index) => Number(res[1][index])).join(',');
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
