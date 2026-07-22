require ["imap4flags", "variables"];

# ─────────────────────────────────────────────────────────────────────────────
# High-confidence sender-domain labels for Fastmail — generated, addflag-ONLY.
#
# Every rule TAGS the message with an IMAP keyword and nothing else: no fileinto,
# no discard, no reject. Sieve's implicit keep still delivers every message to the
# inbox, so a false positive costs a stray keyword, never a hidden email.
#
# HIERARCHICAL education labels (stacked tiers via ${1} capture, variables ext):
#   cs.uw.edu -> edu + uw + cs   ·   uw.edu -> edu + uw   ·   mit.edu -> edu
#
# Matching is by the FROM address domain (:domain), apex + any subdomain. ESP/relay
# infrastructure domains are deliberately excluded — they carry unrelated senders.
#
# Paste into Fastmail → Settings → Rules → Edit custom Sieve code → Save.
# ─────────────────────────────────────────────────────────────────────────────

# UW multi-level subdomains (a.b.uw.edu) — edu + uw (dept too nested to capture cleanly)
if address :domain :matches "from" ["*.*.uw.edu", "*.*.washington.edu"] {
    addflag ["edu", "uw"];
}

# UW department subdomains (cs.uw.edu) — HIERARCHICAL: edu + uw + dept(${1})
elsif address :domain :matches "from" ["*.uw.edu", "*.washington.edu"] {
    addflag ["edu", "uw", "${1}"];
}

# UW apex (uw.edu / washington.edu) — edu + uw
elsif address :domain :matches "from" ["uw.edu", "washington.edu"] {
    addflag ["edu", "uw"];
}

# Generic education — .edu + intl academic TLDs (non-UW) — edu
elsif address :domain :matches "from" ["*.edu", "*.ac.uk", "*.edu.au", "*.ac.nz", "*.ac.jp", "*.edu.cn", "*.edu.sg", "*.ac.in", "*.edu.hk"] {
    addflag "edu";
}

# Government — US .gov + international — label "gov" (7 patterns)
if address :domain :matches "from" ["*.gov", "*.gov.uk", "*.gc.ca", "*.canada.ca", "*.gov.au", "*.govt.nz", "*.europa.eu"] {
    addflag "gov";
}

# US military — .mil — label "mil" (1 pattern)
if address :domain :matches "from" ["*.mil"] {
    addflag "mil";
}

# Banks, card issuers, brokerages, payments & fintech — label "finance" (57 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "usbank.com", "capitalone.com", "pnc.com", "truist.com", "td.com", "tdbank.com", "ally.com", "discover.com", "americanexpress.com", "aexp.com", "synchrony.com", "synchronybank.com", "hsbc.com", "hsbc.co.uk", "barclays.com", "barclaycardus.com", "navyfederal.org", "usaa.com", "schwab.com", "fidelity.com", "vanguard.com", "etrade.com", "morganstanley.com", "ml.com", "merrilledge.com", "tdameritrade.com", "robinhood.com", "sofi.com", "marcus.com", "goldmansachs.com", "paypal.com", "venmo.com", "cash.app", "squareup.com", "block.xyz", "stripe.com", "wise.com", "revolut.com", "coinbase.com", "gemini.com", "kraken.com", "plaid.com", "intuit.com", "turbotax.com", "quickbooks.com", "creditkarma.com", "experian.com", "equifax.com", "transunion.com", "fico.com", "nerdwallet.com", "fanniemae.com"],
    address :domain :matches "from" ["*.chase.com", "*.bankofamerica.com", "*.wellsfargo.com", "*.citi.com", "*.citibank.com", "*.usbank.com", "*.capitalone.com", "*.pnc.com", "*.truist.com", "*.td.com", "*.tdbank.com", "*.ally.com", "*.discover.com", "*.americanexpress.com", "*.aexp.com", "*.synchrony.com", "*.synchronybank.com", "*.hsbc.com", "*.hsbc.co.uk", "*.barclays.com", "*.barclaycardus.com", "*.navyfederal.org", "*.usaa.com", "*.schwab.com", "*.fidelity.com", "*.vanguard.com", "*.etrade.com", "*.morganstanley.com", "*.ml.com", "*.merrilledge.com", "*.tdameritrade.com", "*.robinhood.com", "*.sofi.com", "*.marcus.com", "*.goldmansachs.com", "*.paypal.com", "*.venmo.com", "*.cash.app", "*.squareup.com", "*.block.xyz", "*.stripe.com", "*.wise.com", "*.revolut.com", "*.coinbase.com", "*.gemini.com", "*.kraken.com", "*.plaid.com", "*.intuit.com", "*.turbotax.com", "*.quickbooks.com", "*.creditkarma.com", "*.experian.com", "*.equifax.com", "*.transunion.com", "*.fico.com", "*.nerdwallet.com", "*.fanniemae.com"]
) {
    addflag "finance";
}

# Retail & e-commerce — label "shopping" (49 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["amazon.com", "ebay.com", "etsy.com", "walmart.com", "target.com", "bestbuy.com", "costco.com", "samsclub.com", "homedepot.com", "lowes.com", "ikea.com", "wayfair.com", "overstock.com", "chewy.com", "petco.com", "petsmart.com", "newegg.com", "bhphotovideo.com", "macys.com", "nordstrom.com", "nordstromrack.com", "kohls.com", "gap.com", "oldnavy.com", "bananarepublic.com", "nike.com", "adidas.com", "lululemon.com", "rei.com", "patagonia.com", "backcountry.com", "thenorthface.com", "zappos.com", "sephora.com", "ulta.com", "cvs.com", "walgreens.com", "williams-sonoma.com", "crateandbarrel.com", "potterybarn.com", "aliexpress.com", "temu.com", "shein.com", "shopify.com", "instacart.com", "doordash.com", "ubereats.com", "grubhub.com", "gopuff.com"],
    address :domain :matches "from" ["*.amazon.com", "*.ebay.com", "*.etsy.com", "*.walmart.com", "*.target.com", "*.bestbuy.com", "*.costco.com", "*.samsclub.com", "*.homedepot.com", "*.lowes.com", "*.ikea.com", "*.wayfair.com", "*.overstock.com", "*.chewy.com", "*.petco.com", "*.petsmart.com", "*.newegg.com", "*.bhphotovideo.com", "*.macys.com", "*.nordstrom.com", "*.nordstromrack.com", "*.kohls.com", "*.gap.com", "*.oldnavy.com", "*.bananarepublic.com", "*.nike.com", "*.adidas.com", "*.lululemon.com", "*.rei.com", "*.patagonia.com", "*.backcountry.com", "*.thenorthface.com", "*.zappos.com", "*.sephora.com", "*.ulta.com", "*.cvs.com", "*.walgreens.com", "*.williams-sonoma.com", "*.crateandbarrel.com", "*.potterybarn.com", "*.aliexpress.com", "*.temu.com", "*.shein.com", "*.shopify.com", "*.instacart.com", "*.doordash.com", "*.ubereats.com", "*.grubhub.com", "*.gopuff.com"]
) {
    addflag "shopping";
}

# Airlines, hotels, booking, rail & rideshare — label "travel" (47 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["united.com", "delta.com", "aa.com", "southwest.com", "alaskaair.com", "jetblue.com", "spirit.com", "flyfrontier.com", "hawaiianairlines.com", "britishairways.com", "lufthansa.com", "airfrance.com", "klm.com", "emirates.com", "qatarairways.com", "singaporeair.com", "aircanada.ca", "marriott.com", "hilton.com", "hyatt.com", "ihg.com", "choicehotels.com", "wyndhamhotels.com", "fourseasons.com", "airbnb.com", "vrbo.com", "booking.com", "expedia.com", "hotels.com", "priceline.com", "kayak.com", "orbitz.com", "travelocity.com", "tripadvisor.com", "uber.com", "lyft.com", "amtrak.com", "enterprise.com", "hertz.com", "avis.com", "budget.com", "turo.com", "getaround.com", "viator.com", "ticketmaster.com", "stubhub.com", "seatgeek.com"],
    address :domain :matches "from" ["*.united.com", "*.delta.com", "*.aa.com", "*.southwest.com", "*.alaskaair.com", "*.jetblue.com", "*.spirit.com", "*.flyfrontier.com", "*.hawaiianairlines.com", "*.britishairways.com", "*.lufthansa.com", "*.airfrance.com", "*.klm.com", "*.emirates.com", "*.qatarairways.com", "*.singaporeair.com", "*.aircanada.ca", "*.marriott.com", "*.hilton.com", "*.hyatt.com", "*.ihg.com", "*.choicehotels.com", "*.wyndhamhotels.com", "*.fourseasons.com", "*.airbnb.com", "*.vrbo.com", "*.booking.com", "*.expedia.com", "*.hotels.com", "*.priceline.com", "*.kayak.com", "*.orbitz.com", "*.travelocity.com", "*.tripadvisor.com", "*.uber.com", "*.lyft.com", "*.amtrak.com", "*.enterprise.com", "*.hertz.com", "*.avis.com", "*.budget.com", "*.turo.com", "*.getaround.com", "*.viator.com", "*.ticketmaster.com", "*.stubhub.com", "*.seatgeek.com"]
) {
    addflag "travel";
}

# Carriers, delivery & logistics — label "shipping" (17 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["ups.com", "fedex.com", "usps.com", "dhl.com", "dhl.de", "ontrac.com", "lasership.com", "purolator.com", "canadapost.ca", "canadapost-postescanada.ca", "royalmail.com", "aftership.com", "shipstation.com", "shippo.com", "easypost.com", "narvar.com", "route.com"],
    address :domain :matches "from" ["*.ups.com", "*.fedex.com", "*.usps.com", "*.dhl.com", "*.dhl.de", "*.ontrac.com", "*.lasership.com", "*.purolator.com", "*.canadapost.ca", "*.canadapost-postescanada.ca", "*.royalmail.com", "*.aftership.com", "*.shipstation.com", "*.shippo.com", "*.easypost.com", "*.narvar.com", "*.route.com"]
) {
    addflag "shipping";
}

# Developer tools, CI, cloud & infrastructure — label "dev" (62 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["github.com", "gitlab.com", "bitbucket.org", "atlassian.com", "atlassian.net", "vercel.com", "netlify.com", "circleci.com", "travis-ci.com", "travis-ci.org", "npmjs.com", "docker.com", "cloudflare.com", "amazonaws.com", "awsapps.com", "azure.com", "digitalocean.com", "heroku.com", "linode.com", "akamai.com", "fastly.com", "datadoghq.com", "sentry.io", "pagerduty.com", "opsgenie.com", "hashicorp.com", "mongodb.com", "redis.com", "redislabs.com", "snowflake.com", "databricks.com", "confluent.io", "elastic.co", "gitpod.io", "jetbrains.com", "jfrog.com", "sonatype.com", "sonarsource.com", "sonarcloud.io", "codecov.io", "coveralls.io", "snyk.io", "gitguardian.com", "launchdarkly.com", "twilio.com", "pypi.org", "rubygems.org", "packagist.org", "readthedocs.org", "python.org", "nodejs.org", "golang.org", "rust-lang.org", "kubernetes.io", "cncf.io", "apache.org", "gnu.org", "sourceforge.net", "stackoverflow.com", "stackexchange.com", "hackerone.com", "bugcrowd.com"],
    address :domain :matches "from" ["*.github.com", "*.gitlab.com", "*.bitbucket.org", "*.atlassian.com", "*.atlassian.net", "*.vercel.com", "*.netlify.com", "*.circleci.com", "*.travis-ci.com", "*.travis-ci.org", "*.npmjs.com", "*.docker.com", "*.cloudflare.com", "*.amazonaws.com", "*.awsapps.com", "*.azure.com", "*.digitalocean.com", "*.heroku.com", "*.linode.com", "*.akamai.com", "*.fastly.com", "*.datadoghq.com", "*.sentry.io", "*.pagerduty.com", "*.opsgenie.com", "*.hashicorp.com", "*.mongodb.com", "*.redis.com", "*.redislabs.com", "*.snowflake.com", "*.databricks.com", "*.confluent.io", "*.elastic.co", "*.gitpod.io", "*.jetbrains.com", "*.jfrog.com", "*.sonatype.com", "*.sonarsource.com", "*.sonarcloud.io", "*.codecov.io", "*.coveralls.io", "*.snyk.io", "*.gitguardian.com", "*.launchdarkly.com", "*.twilio.com", "*.pypi.org", "*.rubygems.org", "*.packagist.org", "*.readthedocs.org", "*.python.org", "*.nodejs.org", "*.golang.org", "*.rust-lang.org", "*.kubernetes.io", "*.cncf.io", "*.apache.org", "*.gnu.org", "*.sourceforge.net", "*.stackoverflow.com", "*.stackexchange.com", "*.hackerone.com", "*.bugcrowd.com"]
) {
    addflag "dev";
}

# Platforms, productivity & consumer-tech accounts — label "tech" (46 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["google.com", "microsoft.com", "apple.com", "dropbox.com", "box.com", "adobe.com", "mozilla.org", "zoom.us", "calendly.com", "notion.so", "asana.com", "trello.com", "monday.com", "clickup.com", "airtable.com", "docusign.net", "docusign.com", "hellosign.com", "1password.com", "dashlane.com", "lastpass.com", "bitwarden.com", "okta.com", "auth0.com", "grammarly.com", "evernote.com", "todoist.com", "figma.com", "canva.com", "miro.com", "loom.com", "zendesk.com", "intercom.io", "salesforce.com", "hubspot.com", "zapier.com", "ifttt.com", "samsung.com", "sony.com", "dell.com", "hp.com", "lenovo.com", "logitech.com", "sonos.com", "ring.com", "wyze.com"],
    address :domain :matches "from" ["*.google.com", "*.microsoft.com", "*.apple.com", "*.dropbox.com", "*.box.com", "*.adobe.com", "*.mozilla.org", "*.zoom.us", "*.calendly.com", "*.notion.so", "*.asana.com", "*.trello.com", "*.monday.com", "*.clickup.com", "*.airtable.com", "*.docusign.net", "*.docusign.com", "*.hellosign.com", "*.1password.com", "*.dashlane.com", "*.lastpass.com", "*.bitwarden.com", "*.okta.com", "*.auth0.com", "*.grammarly.com", "*.evernote.com", "*.todoist.com", "*.figma.com", "*.canva.com", "*.miro.com", "*.loom.com", "*.zendesk.com", "*.intercom.io", "*.salesforce.com", "*.hubspot.com", "*.zapier.com", "*.ifttt.com", "*.samsung.com", "*.sony.com", "*.dell.com", "*.hp.com", "*.lenovo.com", "*.logitech.com", "*.sonos.com", "*.ring.com", "*.wyze.com"]
) {
    addflag "tech";
}

# Social networks & communities — label "social" (28 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["facebook.com", "facebookmail.com", "fb.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "reddit.com", "redditmail.com", "pinterest.com", "tiktok.com", "snapchat.com", "discord.com", "discordapp.com", "telegram.org", "whatsapp.com", "nextdoor.com", "meetup.com", "quora.com", "tumblr.com", "twitch.tv", "youtube.com", "vimeo.com", "threads.net", "bsky.app", "strava.com", "goodreads.com", "letterboxd.com"],
    address :domain :matches "from" ["*.facebook.com", "*.facebookmail.com", "*.fb.com", "*.instagram.com", "*.twitter.com", "*.x.com", "*.linkedin.com", "*.reddit.com", "*.redditmail.com", "*.pinterest.com", "*.tiktok.com", "*.snapchat.com", "*.discord.com", "*.discordapp.com", "*.telegram.org", "*.whatsapp.com", "*.nextdoor.com", "*.meetup.com", "*.quora.com", "*.tumblr.com", "*.twitch.tv", "*.youtube.com", "*.vimeo.com", "*.threads.net", "*.bsky.app", "*.strava.com", "*.goodreads.com", "*.letterboxd.com"]
) {
    addflag "social";
}

# News, media & newsletter platforms — label "news" (39 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["nytimes.com", "wsj.com", "dowjones.com", "washingtonpost.com", "theatlantic.com", "economist.com", "ft.com", "bloomberg.com", "reuters.com", "apnews.com", "npr.org", "bbc.co.uk", "bbc.com", "theguardian.com", "cnn.com", "foxnews.com", "nbcnews.com", "cbsnews.com", "politico.com", "axios.com", "vox.com", "wired.com", "arstechnica.com", "theverge.com", "techcrunch.com", "engadget.com", "cnet.com", "seattletimes.com", "thestranger.com", "crosscut.com", "substack.com", "beehiiv.com", "ghost.io", "morningbrew.com", "thehustle.co", "semafor.com", "thedispatch.com", "puck.news", "404media.co"],
    address :domain :matches "from" ["*.nytimes.com", "*.wsj.com", "*.dowjones.com", "*.washingtonpost.com", "*.theatlantic.com", "*.economist.com", "*.ft.com", "*.bloomberg.com", "*.reuters.com", "*.apnews.com", "*.npr.org", "*.bbc.co.uk", "*.bbc.com", "*.theguardian.com", "*.cnn.com", "*.foxnews.com", "*.nbcnews.com", "*.cbsnews.com", "*.politico.com", "*.axios.com", "*.vox.com", "*.wired.com", "*.arstechnica.com", "*.theverge.com", "*.techcrunch.com", "*.engadget.com", "*.cnet.com", "*.seattletimes.com", "*.thestranger.com", "*.crosscut.com", "*.substack.com", "*.beehiiv.com", "*.ghost.io", "*.morningbrew.com", "*.thehustle.co", "*.semafor.com", "*.thedispatch.com", "*.puck.news", "*.404media.co"]
) {
    addflag "news";
}

# Healthcare, insurers & pharmacy (PNW-weighted) — label "health" (25 domains, apex + subdomains)
if anyof (
    address :domain :is "from" ["kaiserpermanente.org", "uwmedicine.org", "providence.org", "swedish.org", "virginiamason.org", "seattlechildrens.org", "cigna.com", "aetna.com", "uhc.com", "unitedhealthcare.com", "bcbs.com", "regence.com", "premera.com", "anthem.com", "humana.com", "express-scripts.com", "caremark.com", "optum.com", "goodrx.com", "zocdoc.com", "onemedical.com", "teladoc.com", "questdiagnostics.com", "labcorp.com", "23andme.com"],
    address :domain :matches "from" ["*.kaiserpermanente.org", "*.uwmedicine.org", "*.providence.org", "*.swedish.org", "*.virginiamason.org", "*.seattlechildrens.org", "*.cigna.com", "*.aetna.com", "*.uhc.com", "*.unitedhealthcare.com", "*.bcbs.com", "*.regence.com", "*.premera.com", "*.anthem.com", "*.humana.com", "*.express-scripts.com", "*.caremark.com", "*.optum.com", "*.goodrx.com", "*.zocdoc.com", "*.onemedical.com", "*.teladoc.com", "*.questdiagnostics.com", "*.labcorp.com", "*.23andme.com"]
) {
    addflag "health";
}
