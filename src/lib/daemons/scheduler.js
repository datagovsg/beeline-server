/**
 * Schedules a polled task represented as the given object
 * This function never returns, and should never be awaited on
 * @param task - a task that has the following fields:
 * name - the name of the task to be logged in console
 * interval - the interval between invocations, in milliseconds
 * run - a 0-arg callback
 */
async function startPolling (task) {
  while (true) {
    try {
      await new Promise(resolve => // eslint-disable-line no-await-in-loop
        setTimeout(() => {
          console.log(`Running task: ${task.name} after ${task.interval}ms elapsed`)
          resolve(task.run())
        }, task.interval))
    } catch (err) {
      console.log(err.stack)
    }
  }
}

module.exports = { startPolling }
