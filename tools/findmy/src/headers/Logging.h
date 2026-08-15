//  Logging.h — findmy-dylib
#include <os/log.h>
#ifndef Logging_h
#define Logging_h
#ifdef DEBUG
#  define ELog(N, ...) os_log_with_type(os_log_create("dev.fig.findmy","DEBUG"),OS_LOG_TYPE_ERROR,N,##__VA_ARGS__)
#  define DLog(N, ...) os_log_with_type(os_log_create("dev.fig.findmy","DEBUG"),OS_LOG_TYPE_DEFAULT,N,##__VA_ARGS__)
#else
#  define ELog(...)
#  define DLog(...)
#endif
#endif
