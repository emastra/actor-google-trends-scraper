const Apify = require('apify');

const { log } = Apify.utils;

const { BASE_URL } = require('./constants');

function validateInput(input) {
    if (!input) throw new Error('INPUT is missing.');
    if (!input.searchTerms) input.searchTerms = [];

    // validate function
    const validate = (inputKey, type = 'string') => {
        const value = input[inputKey];

        if (type === 'array') {
            if (!Array.isArray(value)) {
                throw new Error(`Value of ${inputKey} should be array`);
            }
        } else if (value) {
            if (typeof value !== type) {
                throw new Error(`Value of ${inputKey} should be ${type}`);
            }
        }
    };

    // check required field
    if (input.searchTerms.length <= 0 && !input.spreadsheetId) {
        throw new Error('At least "searchTerms" or "spreadsheetId" must be provided as INPUT.');
    }

    const sheetProvided = !!input.spreadsheetId;

    // check correct types
    validate('searchTerms', 'array');
    if (sheetProvided) {
        validate('spreadsheetId', 'string');
        if (input.spreadsheetId.length !== 44) throw new Error('The spreadsheet ID looks wrong - spreadsheetId field needs to be a string with 44 characters!');
    }
    validate('maxItems', 'number');
    validate('extendOutputFunction', 'string');
    validate('proxyConfiguration', 'object');
}

/**
 * @param {{
 *   geo: string,
 *   category: string,
 *   searchTerm: string,
 *   timeRangeToUse: string,
 * }} params
 */
function newUrl({ geo, timeRangeToUse, category, searchTerm }) {
    const nUrl = new URL(BASE_URL);

    if (geo) {
        nUrl.searchParams.set('geo', geo);
    }

    if (timeRangeToUse) {
        nUrl.searchParams.set('date', timeRangeToUse);
    }

    if (category) {
        nUrl.searchParams.set('cat', category);
    }

    nUrl.searchParams.set('q', decodeURIComponent(searchTerm)); // accepts %2F and /

    return nUrl.toString();
}

async function checkAndCreateUrlSource(searchTerms, spreadsheetId, isPublic, timeRange, category, customTimeRange, geo) {
    /** @type {Apify.RequestOptions[]} */
    const sources = [];
    let output;

    const timeRangeToUse = customTimeRange || timeRange;

    if (searchTerms) {
        for (const searchTerm of searchTerms) {
            sources.push({
                url: newUrl({
                    geo,
                    category,
                    timeRangeToUse,
                    searchTerm,
                }),
                userData: { label: 'SEARCH' }
            });
        }
    }

    if (spreadsheetId) {
        log.info('Importing spreadsheet...');
        const run = await Apify.call('lukaskrivka/google-sheets', {
            mode: 'read',
            spreadsheetId,
            publicSpreadsheet: isPublic,
            deduplicateByEquality: false,
            createBackup: false,
            // tokensStore: "google-oauth-tokens" // default
        });

        output = run.output.body;

        // Validation of the output
        const isBadFormat = output.some((item) => Object.keys(item).length !== 1);
        if (isBadFormat) throw new Error('Spreadsheet must have only one column. Check the actor documentation for more info.');

        log.info('Spreadsheet successfully imported.');

        for (const item of output) {
            const searchTerm = Object.values(item)[0];

            sources.push({
                url: newUrl({
                    geo,
                    category,
                    timeRangeToUse,
                    searchTerm,
                }),
                userData: { label: 'SEARCH' }
            });
        }
    }

    // grab the name of the custom column title
    const sheetTitle = spreadsheetId ? Object.keys(output[0])[0] : 'Term / Date';

    log.info(`Created ${sources.length} Start URLs`);

    return { sources, sheetTitle };
}

function maxItemsCheck(maxItems, itemCount) {
    if (itemCount >= maxItems) {
        log.info('Actor reached the max items limit. Crawler is going to halt...');
        log.info('Crawler Finished.');
        process.exit();
    }
}

function checkAndEval(extendOutputFunction) {
    if (!extendOutputFunction) {
        return;
    }

    let evaledFunc;

    try {
        evaledFunc = eval(extendOutputFunction);
    } catch (e) {
        throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`);
    }

    if (typeof evaledFunc !== 'function') {
        throw new Error('extendOutputFunction is not a function! Please fix it or use just default output!');
    }
}

/**
 * No-op when no extendOutputFunction
 */
async function applyFunction(page, extendOutputFunction) {
    if (!extendOutputFunction) {
        return {};
    }

    const isObject = (val) => typeof val === 'object' && val !== null && !Array.isArray(val);

    let userResult = {};
    try {
        userResult = await page.evaluate(async (eof) => {
            return eval(eof)(window.jQuery);
        }, extendOutputFunction);
    } catch (err) {
        log.error(`extendOutputFunction crashed! Pushing default output. Please fix your function if you want to update the output.\n\t${err}`);
    }

    if (!isObject(userResult)) {
        log.exception(new Error('extendOutputFunction must return an object!'));
        process.exit(1);
    }

    return userResult;
}

/**
 * The actor provides a way to use custom time ranges, so we need to
 * brute force the returned dates. It assumes UTC, might be wrong with
 * other geo parameters
 *
 * @param {string} key
 */
function parseKeyAsIsoDate(key) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentDay = now.getDay();
    const currentMonth = now.getMonth();

    key = key.replace(/\s(AM|PM)/gi, ' $1');

    try {
        // toISOString() throws with 'Invalid time value'. Valid dates with year, Nov 3, 2020
        const newDate = new Date(key);
        if (newDate.getFullYear() < currentYear - 5) {
            // means date is falling back to 2001
            return new Date(`${key}, ${currentYear}`).toISOString();
        }
        return newDate.toISOString();
    } catch (e) {
        try {
            // Nov 13 at 11:00 PM -> Nov 13, 2020, 11:00 PM
            return new Date(key.replace(' at ', `, ${currentYear}, `)).toISOString();
        } catch (e) {
            // 11:00PM
            const dummyDate = new Date(`${currentDay}/${currentMonth + 1}, ${currentYear}, ${key}`);
            now.setHours(dummyDate.getHours(), dummyDate.getMinutes(), 0, 0);
            return now.toISOString();
        }
    }
}


/**
 * Do a generic check when using Apify Proxy
 *
 * @typedef params
 * @property {any} [params.proxyConfig] Provided apify proxy configuration
 * @property {boolean} [params.required] Make the proxy usage required when running on the platform
 * @property {string[]} [params.blacklist] Blacklist of proxy groups, by default it's ['GOOGLE_SERP']
 * @property {boolean} [params.force] By default, it only do the checks on the platform. Force checking regardless where it's running
 * @property {string[]} [params.hint] Hint specific proxy groups that should be used, like SHADER or RESIDENTIAL
 *
 * @param {params} params
 * @returns {Promise<Apify.ProxyConfiguration | undefined>}
 */
const proxyConfiguration = async ({
    proxyConfig,
    required = true,
    force = Apify.isAtHome(),
    blacklist = ['GOOGLE_SERP'],
    hint = []
}) => {
    const configuration = await Apify.createProxyConfiguration(proxyConfig);

    // this works for custom proxyUrls
    if (Apify.isAtHome() && required) {
        if (!configuration || (!configuration.usesApifyProxy && (!configuration.proxyUrls || !configuration.proxyUrls.length)) || !configuration.newUrl()) {
            throw new Error(`\n=======\nYou're required to provide a valid proxy configuration\n\n=======`);
        }
    }

    // check when running on the platform by default
    if (force) {
        // only when actually using Apify proxy it needs to be checked for the groups
        if (configuration && configuration.usesApifyProxy) {
            if (blacklist.some((blacklisted) => (configuration.groups || []).includes(blacklisted))) {
                throw new Error(`\n=======\nUsing any of those proxy groups won't work:\n\n*  ${blacklist.join('\n*  ')}\n\n=======`);
            }

            // specific non-automatic proxy groups like RESIDENTIAL, not an error, just a hint
            if (hint.length && !hint.some((group) => (configuration.groups || []).includes(group))) {
                Apify.utils.log.info(`\n=======\nYou can pick specific proxy groups for better experience:\n\n*  ${hint.join('\n*  ')}\n\n=======`);
            }
        }
    }

    return configuration;
}

module.exports = {
    validateInput,
    parseKeyAsIsoDate,
    checkAndCreateUrlSource,
    proxyConfiguration,
    maxItemsCheck,
    checkAndEval,
    applyFunction,
};
