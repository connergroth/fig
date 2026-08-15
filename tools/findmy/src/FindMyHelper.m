//
//  FindMyHelper.m — findmy-dylib entry point
//
//  Injected into Messages.app via DYLD_INSERT_LIBRARIES. On load it:
//    1. installs the CoreLocation spoof (mini reports a fixed fake location, not
//       its real one) BEFORE any Find My path runs
//    2. after a short delay, starts a file-triggered Find My watcher:
//         - writes a heartbeat every ~2s (liveness signal the host reads)
//         - polls a trigger JSON ({"address":"...","action":"poll"}), runs the
//           Find My read, writes the result JSON
//
//  Self-contained: depends only on FindMyRequestSender (Apple private frameworks)
//  and LocationSpoof. No BlueBubbles / socket-server code.
//
//  The host reads these exact filenames out of the Messages sandbox tmp dir:
//  the heartbeat in src/transport/inject.ts, the trigger + result in
//  src/location/bridge.ts. Keep the names in sync with those two files.
//

#import <Foundation/Foundation.h>
#import "FindMyRequestSender.h"
#import "LocationSpoof.h"

static NSString *const kHeartbeatName = @"findmy-heartbeat.txt";
static NSString *const kTriggerName   = @"findmy-trigger.json";
static NSString *const kResultName    = @"findmy-result.json";

static NSString *tmpPath(NSString *name) {
    return [NSTemporaryDirectory() stringByAppendingPathComponent:name];
}

static void writeFile(NSString *name, NSString *contents) {
    NSData *d = [contents dataUsingEncoding:NSUTF8StringEncoding];
    FILE *f = fopen(tmpPath(name).UTF8String, "w");
    if (f) { fwrite(d.bytes, 1, d.length, f); fclose(f); }
}

static dispatch_source_t gFindMyTimer;

static void startFindMyWatcher(void) {
    NSLog(@"FINDMY: watcher using sandbox tmp: %@", NSTemporaryDirectory());
    dispatch_queue_t q = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, q);
    dispatch_source_set_timer(timer,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)),
        (uint64_t)(2 * NSEC_PER_SEC),
        (uint64_t)(500 * NSEC_PER_MSEC));
    dispatch_source_set_event_handler(timer, ^{
        writeFile(kHeartbeatName,
            [NSString stringWithFormat:@"tick %f\n", [[NSDate date] timeIntervalSince1970]]);

        // consume the trigger file if the host dropped one, then delete it
        NSFileManager *fm = [NSFileManager defaultManager];
        NSString *triggerPath = tmpPath(kTriggerName);
        if (![fm fileExistsAtPath:triggerPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:triggerPath];
        [fm removeItemAtPath:triggerPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (![obj isKindOfClass:[NSDictionary class]]) {
            NSLog(@"FINDMY: trigger JSON invalid: %@", err);
            return;
        }
        NSString *address = obj[@"address"];
        NSString *action  = obj[@"action"] ?: @"share";
        NSLog(@"FINDMY: trigger action=%@ address=%@", action, address);

        dispatch_async(dispatch_get_main_queue(), ^{
            NSString *sendErr = nil;
            BOOL ok = [FindMyRequestSender dispatchAction:action address:address error:&sendErr];
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                NSMutableDictionary *res = [NSMutableDictionary dictionary];
                res[@"success"]   = @(ok);
                res[@"address"]   = address ?: @"";
                res[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
                if (!ok && sendErr) res[@"error"] = sendErr;
                NSData *out = [NSJSONSerialization dataWithJSONObject:res options:NSJSONWritingPrettyPrinted error:nil];
                NSString *json = [[NSString alloc] initWithData:out encoding:NSUTF8StringEncoding];
                writeFile(kResultName, json ?: @"{}");
            });
        });
    });
    dispatch_resume(timer);
    gFindMyTimer = timer;
    NSLog(@"FINDMY: watcher started");
}

__attribute__((constructor))
static void findmy_dylib_init(void) {
    @autoreleasepool {
        NSString *bundleID = [[NSBundle mainBundle] bundleIdentifier];
        if (![bundleID isEqualToString:@"com.apple.MobileSMS"]) {
            NSLog(@"FINDMY: injected into non-Messages process %@, aborting.", bundleID);
            return;
        }
        NSLog(@"FINDMY: loaded into Messages.app");
        [LocationSpoof installIfNeeded];
        // let Messages/IMCore finish coming up before we touch Find My
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{ startFindMyWatcher(); });
    }
}
