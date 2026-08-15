//
//  LocationSpoof.m
//  findmy-dylib
//
//  Runtime-swizzle `-[CLLocationManager location]` so any caller inside
//  Messages.app gets a fake fixed coordinate instead of the real Mac Mini
//  location. fmfd should pick up the fake when it asks for location to
//  share via Find My.
//
//  Fallback path: if fmfd reads from `locationd` directly (bypassing the
//  per-process CLLocationManager cache), the swizzle is a no-op and we'll
//  need to escalate to a locationd-level approach.
//

#import "LocationSpoof.h"
#import <CoreLocation/CoreLocation.h>
#import <objc/runtime.h>

// Fake coordinates. Apple Park in Cupertino — neutral, obviously-spoofed,
// geographically plausible.
static const double kFakeLatitude  = 37.3349;
static const double kFakeLongitude = -122.0090;

static void spoofTrace(NSString *msg) {
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:@"locspoof.log"];
    NSString *line = [NSString stringWithFormat:@"%@ %@\n", [NSDate date], msg];
    FILE *f = fopen(path.UTF8String, "a");
    if (f) { fputs(line.UTF8String, f); fclose(f); }
}

// Build a CLLocation at the fake coordinate, with a recent timestamp and
// plausible horizontal accuracy so callers don't discard it as stale.
static CLLocation *fakeLocation(void) {
    return [[CLLocation alloc]
        initWithCoordinate:CLLocationCoordinate2DMake(kFakeLatitude, kFakeLongitude)
                  altitude:10.0
        horizontalAccuracy:10.0
          verticalAccuracy:10.0
                    course:0.0
                     speed:0.0
                 timestamp:[NSDate date]];
}

// Swizzle target: `- (CLLocation *)location` on CLLocationManager.
static CLLocation *swizzled_location(id self, SEL _cmd) {
    spoofTrace(@"[CLLocationManager location] intercepted -> fake");
    return fakeLocation();
}

@implementation LocationSpoof

+ (void)installIfNeeded {
    static BOOL installed = NO;
    if (installed) return;

    Class cls = NSClassFromString(@"CLLocationManager");
    if (!cls) {
        spoofTrace(@"CLLocationManager class not found — skipping");
        return;
    }

    SEL sel = @selector(location);
    Method m = class_getInstanceMethod(cls, sel);
    if (!m) {
        spoofTrace(@"-[CLLocationManager location] not found — skipping");
        return;
    }

    // Replace the implementation. Keep original around in case we need to
    // restore it for diagnostics (we don't currently).
    IMP original = method_getImplementation(m);
    (void)original;
    method_setImplementation(m, (IMP)swizzled_location);

    installed = YES;
    spoofTrace([NSString stringWithFormat:
        @"installed location spoof: lat=%f lng=%f",
        kFakeLatitude, kFakeLongitude]);
}

@end
