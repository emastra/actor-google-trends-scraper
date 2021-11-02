## Features
[Google Trends](https://trends.google.com/trends) does not have an API, but Google Trends Scraper creates an unofficial Google Trends API to let you extract data from Google Trends directly and at scale. It is built on the powerful [Apify SDK](https://sdk.apify.com/) and you can run it on the [Apify platform](https://my.apify.com) and locally.

## Why scrape Google Trends?
Google Trends lets you find out what people have been searching for around the globe, as well as what ideas and fashions are just emerging. By analyzing this at scale, you can learn what to invest in, and where to spend your resources most effectively.

Whether you’re a journalist researching hot topics, a real estate developer keeping an eye on future property values, an SEO expert tracking keywords, or an e-commerce retailer thriving on the edge with dropshipping, Google Trends has useful data for you.

## Cost of usage
Google Trends Scraper works best if you feed it more keywords for each scrape. In our experience, if you give it 1,000 keywords all at once, it will cost you approximately USD 0.80. If you give it only one keyword at a time, it will cost approx. USD 2.00-8.00.

## Tutorials
Check out our [step-by-step guide to scraping Google Trends](https://blog.apify.com/step-by-step-guide-to-scraping-google-trends/). It includes use cases, screenshots, and examples.

## Input
| Field | Type | Description |
| ----- | ---- | ----------- |
| searchTerms | array | This is the list of search terms to be scraped (required if 'spreadsheetId' is not provided). |
| spreadsheetId | string | (Optional) Id of the google sheet from where search terms will be loaded. |
| isPublic | boolean | If checked, you can import a public spreadsheet without the need for authorization. To import private sheets, please read about authorization below. Defaults to `false`. |
| timeRange | string | Choose a time range (defaults to 'Past 12 months') |
| category | string | Choose a category to filter the search (defaults to 'All categories') |
| geo | string | Get results from a specific geo area (defaults to 'Worldwide') |
| maxItems | number | (optional) Maximum number of product items to be scraped |
| customTimeRange | string | Provide a custom time range. If provided, it takes precedence over regular timeRange. Read [Custom time range](#custom-time-range) for correct format and examples. |
| extendOutputFunction | string | (optional) Function that takes a JQuery handle ($) as argument and returns data that will be merged with the default output. More information in [Extend output function](#extend-output-function) |
| proxyConfiguration | object | (Optional) Proxy settings. If you have access to Apify Proxy, leave the default settings. If not, you can set `{ "useApifyProxy": false" }` to disable proxy usage. |

**Notes on input as spreadsheet**
- The only spreadsheet allowed is a Google Sheet.
- Spreadsheet must have only one column.
- The first row of the spreadsheet is considered the title of the column so it will not be loaded as a search term.
- [See Google Sheet example](https://github.com/emastra/actor-google-trends-scraper/blob/master/google-sheet-example.png)

**Notes on timeRange**\
On the Apify platform you can choose the time range with a dropdown menu.
If you provide the input as JSON, these are the `timeRange` possible values:<br />
```
`now 1-H` (equals to Past hour)
`now 4-H` (equals to Past 4 hours)
`now 1-d` (equals to Past day)
`now 7-d` (equals to Past 7 days)
`today 1-m` (equals to Past 30 days)
`today 3-m` (equals to Past 90 days)
`''` (empty string equals to Past 12 months. It's the default)
`today 5-y` (equals to Past 5 years)
`all` (equals to 2004-present)
```

**INPUT Example:**

```
{
  "searchTerms": [
    "test term",
    "another test term"
  ],
  "spreadsheetId": spreadsheetId,
  "timeRange": "now 4-H",
  "isPublic": true,
  "maxItems": 100,
  "customTimeRange": "2020-03-24 2020-03-29",
  "extendOutputFunction": "($) => { return { test: 1234, test2: 5678 } }",
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

### Output

The scraper's output is stored in a dataset.
Each item will contain the search term and all values keyed by the corresponding date.

Example of one output item:

```jsonc
{
  "searchTerm": "CNN",
  "‪Jan 13, 2019‬": 92,
  "‪Jan 20, 2019‬": 100,
  "‪Jan 27, 2019‬": 86,
  "‪Feb 3, 2019‬": 82,
  //...
}
```

If you set `outputAsISODate` to `true`, it will show as:

```jsonc
{
  "Term / Date": "CNN",
  "2019-08-11T03:00:00.000Z": 43,
  "2019-08-18T03:00:00.000Z": 34,
  "2019-08-25T03:00:00.000Z": 34,
  // ...
}
```

### Authorization

Authorization is needed only if your Google Sheet is private. 

Google Trends Scraper internally runs [Google Sheets Import & Export actor](https://apify.com/lukaskrivka/google-sheets#authentication-and-authorization). The authorization process needs to be carried out by running this actor separately in your account. After running it once, the actor will save a token in your KV store and Google Trends Scraper will use it automatically. This means that after running [Google Sheets Import & Export actor](https://apify.com/lukaskrivka/google-sheets#authentication-and-authorization) just once, you can fully automate  Google Trends Scraper  without setting authorization parameters every time.

Please check this [article](https://help.apify.com/en/articles/2424053-google-integration) for instructions on how to authorize using [Google Sheets Import & Export actor](https://apify.com/lukaskrivka/google-sheets#authentication-and-authorization).

If you want to use more spreadsheets from different Google accounts, then each Google account needs to have a different tokensStore. You need to track which tokens belong to which account by naming the store properly.

You may download the output as a nicely formatted spreadsheet from the *dataset* tab of your actor run.

### Custom time range

Custom time range is a string with the following order:\
`startDate endDate`\
And the following format:\
`YYYY-MM-DD YYYY-MM-DD`

Examples:
```
2020-01-30 2020-03-29
```
```
2019-03-20 2019-03-26
```

Only when the range is up to 7 days, each date supports the time as well.
Examples:
```
2020-03-24T08 2020-03-29T15
```

### Extend output function
You can use this function to update the default output of this actor. This function gets a JQuery handle `$` as an argument so you can choose what data from the page you want to scrape. The output from this will function will get merged with the default output.

The **return value** of this function has to be an **object**!

You can return fields to achieve 3 different things:
- Add a new field - Return object with a field that is not in the default output
- Change a field - Return an existing field with a new value
- Remove a field - Return an existing field with a value `undefined`

The following example will add a new field:

```js
($) => {
    return {
        comment: 'This is a comment',
    }
}
```

You can also get the related keyword and link trends by using this:

```js
($) => {
    return {
        trends: $('a[href^="/trends/explore"] .label-text')
          .map((_, s) => ({
              text: s.innerText,
              link: s.closest('a').href
          }))
          .toArray()
    }
}
```

### Report issues
If you find any bugs, please create an issue on the [GitHub page](https://github.com/emastra/actor-google-trends-scraper).
