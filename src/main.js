const Apify = require('apify');
const querystring = require('querystring');
const UserAgent = require('user-agents');

const { log } = Apify.utils;

const {
    validateInput,
    checkAndCreateUrlSource,
    maxItemsCheck,
    checkAndEval,
    applyFunction,
} = require('./utils');

// READ THIS BEFORE YOU TOUCH THE CODE!!!

// There is super weird anti-scraping system here
// The first page always gives you 429 but you MUST NOT throw out the proxy
// Only the second and consequent usage works

// WE CANNOT UPGRADE TO SDK 0.21.4+ because it auto kills session on 429
// or we have to remove SessionPool completely (it might be still useful though)

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
        gotoFunction: async ({ request, page, session }) => {
            if (!session.userData.userAgent) {
                session.userData.userAgent = new UserAgent().toString();
            }
            await page.setUserAgent(session.userData.userAgent);
            return page.goto(request.url, {
                timeout: pageLoadTimeoutSecs * 1000,
                waitUntil: 'domcontentloaded', // 'networkidle2', TODO: We have to figure this out
            });
        },
        handlePageFunction: async ({ page, request }) => {
            // if exists, check items limit. If limit is reached crawler will exit.
            if (maxItems) maxItemsCheck(maxItems, itemCount);

            log.info('Processing:', { url: request.url });
            const { label } = request.userData;

            if (label === 'START') {
                if (extendOutputFunction) {
                    await Apify.utils.puppeteer.injectJQuery(page);
                }
                // const searchTerm = decodeURIComponent(request.url.split('?')[1].split('=')[1]);
                const queryStringObj = querystring.parse(request.url.split('?')[1]);
                const searchTerm = queryStringObj.q;

                const is429 = await page.evaluate(() => !!document.querySelector('div#af-error-container'));
                if (is429) {
                    // eslint-disable-next-line no-throw-literal
                    throw 'Page got a 429 Error. Google is baiting us to throw out the proxy but we need to stick with it...';
                }

                // The data are loading as well as the empty results error
                // So we race between them so we don't wait unecessarily

                // Returns false value if the empty selector is found
                const waitForEmptyDataSelector = async () => {
                    await page.waitForSelector('[widget-name=TIMESERIES]', { timeout: 120 * 1000 });
                    await page.waitForFunction(async () => {
                        const widget = document.querySelector('[widget-name=TIMESERIES]');
                        return !!widget.querySelector('p.widget-error-title');
                    });
                    return false;
                };

                // Returns truhly value if the data selector is found
                const waitForDataSelector = page.waitForSelector('svg ~ div > table > tbody', { timeout: 115 * 1000 });

                // Evaluates either to boolean (false if empty data) or a truthly selector
                const hasData = await Promise.race([waitForDataSelector, waitForEmptyDataSelector()]);

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
