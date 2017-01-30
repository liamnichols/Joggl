#!/usr/bin/env node

// Define the program entry
const ver = "0.0.1"
const co = require('co')
const prompt = require('co-prompt')
const chalk = require('chalk')
const url = require('url')
const moment = require('moment')
const request = require('superagent')
const program = require('commander')
program
    .option('-d, --date <date>', 'The date in YYYY-MM-DD format')
    .option('-a, --apiToken <apiToken>', 'The Toggl API Token')
    .option('-w, --workspace <workspace>', 'The Toggl Workspace identifier')
    .option('-u, --username <username>', 'The username for the Jira Account')
    .option('-p, --password <password>', 'The password for the Jira Account')
    .parse(process.argv)

function findJiraIds(string) {
    // Match
    var m = string.match(/([a-zA-Z][a-zA-Z0-9_]+-[1-9][0-9]*)/g)

    if (!m) {
        return []
    } else {
        return m
    }
}

// Run everything in the instance of co for interactive prompting
co(function *() {
    
    // Get the API Key from args or prompt
    let apiToken = program.apiToken
    if (!apiToken) {
        console.log(chalk.yellow("Missing Toggl API Token. Get it from " + chalk.underline("https://www.toggl.com/app/profile")))
        apiToken = yield prompt('API Token: ')
        console.log("")
    }
    
    // Get the workspace id or prompt
    let workspace = program.workspace
    if (!workspace) {
        console.log(chalk.yellow("Missing Toggl Workspace Id. Get it from " + chalk.underline("https://www.toggl.com/app/reports/summary/")))
        apiToken = yield prompt('Workspace Id: ')
        console.log("")
    }
    
    // Work out the date
    let date = program.date
    if (!date) {
        date = moment().format("YYYY-MM-DD")
    }
    
    // Form the url
    let reportUrl = url.format({
        protocol: "https:",
        hostname: "toggl.com",
        pathname: "/reports/api/v2/details",
        query: {
            user_agent: "joggl-cli",
            workspace_id: workspace,
            page: 1,
            since: date,
            until: date 
        }
    })
    
    // Log what we are doing
    console.log("Fetching the Toggl report for", date)
    console.log("API Request: [GET]", chalk.underline(reportUrl))
    
    // Make the request
    request
        .get(reportUrl)
        .auth(apiToken, 'api_token')
        .set('Accept', 'application/json')
        .end((err, res) => {
            
            // Make sure the API returned something
            if (err) {
                console.error(chalk.red(err.message))
                console.error(err)
                process.exit(1)
            }
            
            // Make sure we have all the data in the response
            if (res.body.total_count > res.body.per_page) {
                console.error(chalk.red("You have too many entries for this date. Joggl currently only supports a max of " + res.body.per_page))
                process.exit(1)
            }
            
            console.log(chalk.green("Found " + res.body.data.length + " item(s).") + " Mapping data")
            
            // Map the raw data to a bunch of entries
            let projects = { }
            res.body.data.forEach(log => {
                
                // Fetch or make the project
                let project = projects[log.pid]
                if (!project) {
                    project = {
                        name: log.project,
                        id: log.pid,
                        items: { }
                    }
                }
                
                // Fetch or make the item
                let item = project.items[log.description]
                if (!item) {
                    item = {
                        description: log.description,
                        jiraIds: findJiraIds(log.description),
                        duration: 0.0,
                        occurrences: 0
                    }
                }
                
                // Update the item
                item.duration += log.dur
                item.occurrences += 1
                
                // Update the project
                project.items[log.description] = item
                
                // Update the projects
                projects[log.pid] = project
            })
            
            // Now we've merged the same tasks together, loop round and form a single array
            let allItems = [ ]
            let totalDuration = 0
            for (var pid in projects) {
                if (projects.hasOwnProperty(pid)) {
                    let project = projects[pid]
                    let items = project.items
                    for (var itemDesc in items) {
                        if (items.hasOwnProperty(itemDesc)) {
                            let item = items[itemDesc]
                            // Set the project name on the item and add the item
                            item.project = projects[pid].name
                            allItems.push(item)
                            totalDuration += item.duration
                        }
                    }
                }
            }
            
            // Make sure we have stuff to report
            if (allItems.length === 0) {
                console.log("There are no items to report for " + date)
                process.exit(0)
            }
            
            // Loop all the items
            let issues = 0
            let i = 1
            let uniqueJiraIds = [ ]
            console.log(chalk.underline("Summary:"))
            allItems.forEach(item => {
                let desc = item.description
                let dur = moment(item.duration)
                let count = item.occurrences
                let jira = item.jiraIds.join(", ")
                item.jiraId = item.jiraIds[0] // track the id we want to work with
                
                // Get an array of unique id's for later
                if (item.jiraId && uniqueJiraIds.indexOf(item.jiraId) === -1) {
                    uniqueJiraIds.push(item.jiraId)
                }
                
                // Log the item
                console.log("")
                console.log(chalk.underline(i + ".") + " " + desc)
                console.log("   duration: " + chalk.bold(moment.utc(dur).format("HH:mm:ss")))
                console.log("   count: " + chalk.bold(count))
                console.log("   Jira Id: " + chalk.bold(jira))
                if (item.jiraIds.length == 1) {
                    console.log("   Status: " + chalk.green("Ready"))
                } else if (item.jiraIds.length == 0) {
                    console.log("   Status: " + chalk.red("No Jira Id"))
                    issues ++
                } else {
                    console.log("   Status: " + chalk.red("Multiple Jira Ids"))
                    issues ++
                }
                i++
            })
            
            console.log("")
            if (issues > 0) {
                console.error(chalk.red(chalk.bold("Error:") + " There were " + issues + " issue(s) detected. Please resolve and try again"))
                process.exit(1)
            }
            
            // Work out the jira tickets we want to work with
            let jql = 'key in ("' + uniqueJiraIds.join('","') + '")'
            console.log("Verifying existance of issues matching JQL: " + chalk.bold(jql))
            
            co(function *() {
                
                // Get the username from args or prompt
                let username = program.username
                if (!username) {
                    username = yield prompt('Jira Username: ')
                    console.log("")
                }
                
                // Get the username from args or prompt
                let password = program.password
                if (!password) {
                    password = yield prompt.password('Jira Password: ')
                    console.log("")
                }
                
                // Form the url
                let queryUrl = url.format({
                    protocol: "https:",
                    hostname: "rockpool.atlassian.net",
                    pathname: "/rest/api/2/search",
                    query: {
                        jql: jql
                    }
                })
                
                // Make the request
                request
                    .get(queryUrl)
                    .auth(username, password)
                    .set('Accept', 'application/json')
                    .end((err, res) => {

                        // Make sure the API returned something
                        if (err) {
                            console.error(chalk.red(err.message))
                            console.error(err)
                            process.exit(1)
                        }
                        
                        // Map the issues into a dictionary to check over
                        let issues = { }
                        res.body.issues.forEach(issue => {
                            issues[issue.key] = {
                                key: issue.key,
                                isSubtask: issue.fields.issuetype.subtask
                            }
                        })
                        
                        // Verify each ticket in uniqueJiraIds
                        let errors = 0
                        uniqueJiraIds.forEach(key => {
                            let issue = issues[key]
                            if (!issue) {
                                console.log(key + ":" + chalk.red(" Doesn't exist"))
                                errors++
                            } else if (!issue.isSubtask) {
                                console.log(key + ":" + chalk.red(" Not a subtask"))
                                errors++
                            } else {
                                console.log(key + ":" + chalk.green(" Found"))
                            }
                        })
                        
                        if (errors > 0) {
                            console.error(chalk.red(chalk.bold("Error:") + " There were " + errors + " issue(s) detected. Please resolve and try again"))
                            process.exit(1)
                        }
                        
                        // Create a work log for each item
                        co(function *() {
                            console.log("")
                            console.log("Joggl is about to create " + allItems.length + " work log(s) with a total time of " + chalk.bold(moment.utc(totalDuration).format("HH:mm:ss")) + ".")
                            let ok = yield prompt.confirm("Are you sure? (y/n): ")
                            
                            // Exit now if we said no
                            if (!ok) {
                                process.exit(0)
                            }
                            
                            // Method to create the work log
                            function createNextWorkLog() {
                                
                                console.log("")
                                
                                // If there are no items left, exit
                                if (allItems.length === 0) {
                                    console.log("All work log items have been created successfully (you should probably double check though)")
                                    process.exit(0)
                                }
                                
                                // Pop the next item from the array
                                let item = allItems.shift()
                                let jiraId = item.jiraId
                                let timeInSeconds = item.duration / 1000.0
                                let comment = item.description + " \n\n(Imported via Joggl)"
                                let started = date + "T00:00:00.000+0000"
                                
                                // Form the url
                                let worklogUrl = url.format({
                                    protocol: "https:",
                                    hostname: "rockpool.atlassian.net",
                                    pathname: "/rest/api/2/issue/" + jiraId + "/worklog"
                                })
                                
                                // Create the post body
                                let body = {
                                    comment: comment,
                                    timeSpentSeconds: timeInSeconds,
                                    started: started
                                }
                                
                                // Log what we are doing
                                console.log("Adding " + chalk.bold(timeInSeconds + " seconds") + " to " + chalk.bold(jiraId) + " on " + chalk.bold(started))
                                
                                // Run the request
                                request
                                    .post(worklogUrl)
                                    .send(body)
                                    .auth(username, password)
                                    .set('Accept', 'application/json')
                                    .end((err, res) => {
                                        
                                        // if we got 201, it was good so move on
                                        if (res.statusCode === 201) {
                                            console.log(chalk.green("    Done"))
                                            createNextWorkLog()
                                        } else {
                                            console.log(chalk.red("    Failed"))
                                            console.log("")
                                            console.error(err)
                                            process.exit(1)
                                        } 
                                    })
                            }
                            
                            // Create the next work log
                            createNextWorkLog()
                        })
                    })
            })
        })
})