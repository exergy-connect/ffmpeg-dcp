/*
 * Synchronous pthread_create/pthread_join shim - EXPERIMENTAL, testing
 * whether ffmpeg's CLI scheduler (fftools/ffmpeg_sched.c) tolerates
 * running each "thread" inline instead of concurrently. Likely to
 * deadlock for pipelines where stages are meant to run concurrently
 * against a bounded queue; this is a quick empirical test, not
 * assumed to be the final fix.
 */
#include <pthread.h>
#include <stdint.h>

int __wrap_pthread_create(pthread_t *thread, const pthread_attr_t *attr,
                           void *(*start_routine)(void *), void *arg) {
  if (thread) *thread = (pthread_t)(uintptr_t)1;
  start_routine(arg);
  return 0;
}

int __wrap_pthread_join(pthread_t thread, void **retval) {
  if (retval) *retval = NULL;
  return 0;
}
