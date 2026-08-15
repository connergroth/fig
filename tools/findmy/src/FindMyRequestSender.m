//
//  FindMyRequestSender.m
//  Diagnostic + production entry points.
//
//  Actions:
//    "share"  — onboarding handshake (shareLocationWithDuration:0)
//    "poll"   — refresh+read cache
//    "stop"   — stop our outgoing share
//    "status" — dump FMLSession friendship state (who is sharing with us,
//               who we're sharing with, expiry timestamps)
//

#import "FindMyRequestSender.h"
#import "IMCore.h"
#import "IMAccountController.h"
#import "IMAccount.h"
#import "IMHandle.h"
#import "IMChat.h"
#import "IMChatRegistry.h"
#import "IMFMFSession.h"
#import "FMLHandle.h"
#import "FMLLocation.h"
#import "FMFHandle.h"
#import "FMFLocation.h"
#import <CoreLocation/CoreLocation.h>
#import "Logging.h"
#import <objc/runtime.h>

@interface IMChat (FindMyShareLocation)
- (void)shareLocationWithDuration:(long long)duration;
- (BOOL)_supportsShareLocation;
- (void)stopSharingLocation;
@end

static void fmrTrace(NSString *tag, NSString *msg) {
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:@"findmy-trace.log"];
    NSString *line = [NSString stringWithFormat:@"%@ [%@] %@\n", [NSDate date], tag, msg];
    FILE *f = fopen(path.UTF8String, "a");
    if (f) { fputs(line.UTF8String, f); fclose(f); }
}

static void writeResultNamed(NSString *filename, NSData *data) {
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:filename];
    FILE *f = fopen(path.UTF8String, "w");
    if (f) { fwrite(data.bytes, 1, data.length, f); fclose(f); }
}

static void writeResult(NSString *filename, NSDictionary *dict) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:dict
                                                    options:NSJSONWritingPrettyPrinted
                                                      error:nil];
    writeResultNamed(filename, data);
}

@implementation FindMyRequestSender

+ (BOOL)shareLocationWithAddress:(NSString *)address error:(NSString **)errorOut {
    #define FMR_FAIL(msg) do { if (errorOut) *errorOut = (msg); fmrTrace(@"FAIL", (msg)); return NO; } while (0)
    IMAccount *account = [[IMAccountController sharedInstance] activeIMessageAccount];
    if (!account) FMR_FAIL(@"no iMessage account");
    IMHandle *handle = [account imHandleWithID:address];
    if (!handle) FMR_FAIL(@"no IMHandle");
    IMChat *chat = [[IMChatRegistry sharedInstance] chatForIMHandle:handle];
    if (!chat) FMR_FAIL(@"no IMChat");
    if ([chat respondsToSelector:@selector(_supportsShareLocation)]
        && ![chat _supportsShareLocation]) FMR_FAIL(@"chat does not support share");

    long long duration = 0;  // 0 = Indefinite (enum, NOT seconds)
    fmrTrace(@"SHARE", [NSString stringWithFormat:@"[chat shareLocationWithDuration:%lld] to %@", duration, address]);
    NSMethodSignature *sig = [chat methodSignatureForSelector:@selector(shareLocationWithDuration:)];
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
    [inv setTarget:chat]; [inv setSelector:@selector(shareLocationWithDuration:)];
    [inv setArgument:&duration atIndex:2];
    [inv invoke];
    return YES;
    #undef FMR_FAIL
}

+ (BOOL)stopSharingWithAddress:(NSString *)address error:(NSString **)errorOut {
    #define FMR_FAIL(msg) do { if (errorOut) *errorOut = (msg); fmrTrace(@"FAIL", (msg)); return NO; } while (0)
    IMAccount *account = [[IMAccountController sharedInstance] activeIMessageAccount];
    if (!account) FMR_FAIL(@"no iMessage account");
    IMHandle *handle = [account imHandleWithID:address];
    if (!handle) FMR_FAIL(@"no IMHandle");
    IMChat *chat = [[IMChatRegistry sharedInstance] chatForIMHandle:handle];
    if (!chat) FMR_FAIL(@"no IMChat");
    fmrTrace(@"STOP", [NSString stringWithFormat:@"stopSharingLocation for %@", address]);
    [chat performSelector:@selector(stopSharingLocation)];
    return YES;
    #undef FMR_FAIL
}

// Helper: parse a fmlSession's `description`-style FMLLocation and emit our
// JSON result file shape. Used both in the cache-only fast path and after
// a refresh completes.
static void writeLocationFromFMLObject(id location, NSString *address) {
    if (!location) {
        writeResult(@"findmy-location.json", @{@"success": @NO, @"error": @"no location"});
        return;
    }
    NSString *desc = [location description];
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    out[@"success"] = @YES;
    out[@"address"] = address;
    out[@"source"] = @"fml";
    out[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
    out[@"rawDescription"] = desc ?: @"";

    NSRegularExpression *re = [NSRegularExpression
        regularExpressionWithPattern:@"longitude:(-?\\d+\\.?\\d*)\\s+latitude:(-?\\d+\\.?\\d*)"
                             options:0 error:nil];
    NSTextCheckingResult *m = [re firstMatchInString:desc options:0 range:NSMakeRange(0, desc.length)];
    if (m && m.numberOfRanges >= 3) {
        out[@"longitude"] = @([[desc substringWithRange:[m rangeAtIndex:1]] doubleValue]);
        out[@"latitude"]  = @([[desc substringWithRange:[m rangeAtIndex:2]] doubleValue]);
    }
    NSRegularExpression *addrRe = [NSRegularExpression
        regularExpressionWithPattern:@"coarseAddressLabel:([^\\n]+)"
                             options:0 error:nil];
    NSTextCheckingResult *am = [addrRe firstMatchInString:desc options:0 range:NSMakeRange(0, desc.length)];
    if (am && am.numberOfRanges >= 2) {
        out[@"coarseAddress"] = [[desc substringWithRange:[am rangeAtIndex:1]]
            stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    }
    writeResult(@"findmy-location.json", out);
}

// Helper: extract typed coords + addresses from an `FMFLocation` (older
// Obj-C class — not Swift-bridged). Used by the FMF cache path that avoids
// the FindMyLocateSession Swift queue (`com.apple.findmy.findmylocated.
// ObjCBootstrap`) entirely. That queue began segfaulting on
// `cachedLocationForHandle:` calls in macOS 15.5 (verified June 2026);
// FMFSession is the older, pure-Obj-C parallel that should still be safe.
static void writeLocationFromFMFObject(id location, NSString *address) {
    if (!location) {
        writeResult(@"findmy-location.json", @{@"success": @NO, @"error": @"no location"});
        return;
    }
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    out[@"success"] = @YES;
    out[@"address"] = address;
    out[@"source"] = @"fmf";
    out[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
    out[@"rawDescription"] = [location description] ?: @"";

    // FMFLocation exposes CLLocationCoordinate2D coordinate.
    if ([location respondsToSelector:@selector(coordinate)]) {
        NSMethodSignature *sig = [location methodSignatureForSelector:@selector(coordinate)];
        NSInvocation *ci = [NSInvocation invocationWithMethodSignature:sig];
        [ci setTarget:location];
        [ci setSelector:@selector(coordinate)];
        [ci invoke];
        CLLocationCoordinate2D coord = {0, 0};
        [ci getReturnValue:&coord];
        if (CLLocationCoordinate2DIsValid(coord) && (coord.latitude != 0 || coord.longitude != 0)) {
            out[@"latitude"]  = @(coord.latitude);
            out[@"longitude"] = @(coord.longitude);
        }
    }

    // Typed address properties — much cleaner than parsing description.
    for (NSString *sel in @[@"shortAddress", @"longAddress", @"title", @"subtitle"]) {
        SEL s = NSSelectorFromString(sel);
        if ([location respondsToSelector:s]) {
            id v = [location performSelector:s];
            if ([v isKindOfClass:[NSString class]] && [(NSString *)v length] > 0) {
                NSString *outKey = sel;
                // Map to the field name the relay/backend expects.
                if ([sel isEqualToString:@"shortAddress"]) outKey = @"coarseAddress";
                if ([sel isEqualToString:@"longAddress"]) outKey = @"formattedAddress";
                out[outKey] = v;
            }
        }
    }
    writeResult(@"findmy-location.json", out);
}

// Track addresses with an in-flight refresh so we never call
// `startRefreshingLocationForHandles:` concurrently for the same handle.
//
// The April-22 crash was caused by overlapping refresh calls racing the
// `IMFindMyLocation` notification observer in Apple's ChatKit
// (`-[CKNavbarCanvasViewController fmfSessionChatLocationReceived:]`),
// which read a freed object and faulted in `objc_retain`. Serialising
// per address prevents that.
//
// Each entry is auto-cleared either when the refresh completion fires
// or after a hard timeout (kRefreshTimeoutSeconds) so a hung session
// doesn't permanently lock the address.
static const NSTimeInterval kRefreshTimeoutSeconds = 30.0;

+ (NSMutableSet<NSString *> *)inflightRefreshSet {
    static NSMutableSet<NSString *> *set;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ set = [NSMutableSet new]; });
    return set;
}

+ (BOOL)claimRefreshSlotForAddress:(NSString *)address {
    NSMutableSet<NSString *> *set = [self inflightRefreshSet];
    @synchronized (set) {
        if ([set containsObject:address]) return NO;
        [set addObject:address];
    }
    // Hard timeout: if completion never fires, clear after 30s so we
    // don't lock out the address forever.
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRefreshTimeoutSeconds * NSEC_PER_SEC)),
        dispatch_get_global_queue(QOS_CLASS_BACKGROUND, 0),
        ^{ [FindMyRequestSender releaseRefreshSlotForAddress:address]; });
    return YES;
}

+ (void)releaseRefreshSlotForAddress:(NSString *)address {
    NSMutableSet<NSString *> *set = [self inflightRefreshSet];
    @synchronized (set) {
        [set removeObject:address];
    }
}

+ (BOOL)pollLocationForAddress:(NSString *)address error:(NSString **)errorOut {
    #define FMR_FAIL(msg) do { if (errorOut) *errorOut = (msg); fmrTrace(@"FAIL", (msg)); return NO; } while (0)

    Class IMFMFSessionClass = NSClassFromString(@"IMFMFSession");
    id imfmf = [IMFMFSessionClass performSelector:@selector(sharedInstance)];
    if (!imfmf) FMR_FAIL(@"IMFMFSession.sharedInstance nil");

    // ─── PATH 0: IMFMFSession.findMyLocationForHandle: (Obj-C) ───────
    //
    // IMFMFSession is the IMCore-level wrapper that ChatKit's own UI uses.
    // Its `findMyLocationForHandle:` returns an IMFindMyLocation which
    // wraps both the FMF and FML location objects. This is the Obj-C
    // path Messages.app's contact-card UI takes, so it should be safe.
    // ─── PATH 0z: IMHandle (NOT IMFindMyHandle) ──────────────────────
    //
    // Reverse-engineered from the macOS 15.5 IMCore runtime: Apple's
    // implementation of `-[IMFMFSession findMyLocationForHandle:]`
    // internally does `[arg findMyHandle]`. That selector lives on
    // **IMHandle**, not on IMFindMyHandle. Pass an IMHandle and it
    // works; pass IMFindMyHandle and it dies with "unrecognized selector".
    //
    // This is the path Messages.app's own UI takes (it always has an
    // IMHandle in hand, never an IMFindMyHandle).
    {
        IMAccount *imAccount = [[IMAccountController sharedInstance] activeIMessageAccount];
        IMHandle *imHandle = [imAccount imHandleWithID:address];
        fmrTrace(@"POLL", ([NSString stringWithFormat:
            @"IMHandle for %@: %@",
            address,
            imHandle ? NSStringFromClass([imHandle class]) : @"nil"]));

        // Subscribe to ongoing location updates the first time we see
        // this address. Without this, fmfd's local cache goes stale (we
        // observed ~22 hours of stale data on 2026-06-15 before adding
        // this subscription). startTrackingLocationForHandle: is the
        // same call ChatKit uses when you open a Find My friend's detail
        // view — fmfd starts pushing fresh location data via APS, and
        // our IMFindMyLocation cache stays warm.
        //
        // Idempotent across the lifetime of this Messages.app process.
        // On Messages restart, the set resets and we re-subscribe on the
        // first poll.
        if (imHandle && [imfmf respondsToSelector:@selector(startTrackingLocationForHandle:)]) {
            static NSMutableSet *subscribedAddresses;
            static dispatch_once_t once;
            dispatch_once(&once, ^{ subscribedAddresses = [NSMutableSet new]; });

            BOOL needsSubscribe = NO;
            @synchronized (subscribedAddresses) {
                if (![subscribedAddresses containsObject:address]) {
                    [subscribedAddresses addObject:address];
                    needsSubscribe = YES;
                }
            }
            if (needsSubscribe) {
                @try {
                    [imfmf performSelector:@selector(startTrackingLocationForHandle:)
                                withObject:imHandle];
                    fmrTrace(@"POLL", ([NSString stringWithFormat:
                        @"subscribed to live updates for %@", address]));
                } @catch (NSException *e) {
                    fmrTrace(@"POLL", ([NSString stringWithFormat:
                        @"startTrackingLocationForHandle threw: %@", e]));
                    // Roll back so we retry next poll
                    @synchronized (subscribedAddresses) {
                        [subscribedAddresses removeObject:address];
                    }
                }
            }
        }

        if (imHandle && [imfmf respondsToSelector:@selector(findMyLocationForHandle:)]) {
            id imfmLocation = nil;
            @try {
                imfmLocation = [imfmf performSelector:@selector(findMyLocationForHandle:)
                                          withObject:imHandle];
            } @catch (NSException *e) {
                fmrTrace(@"POLL", [NSString stringWithFormat:
                    @"findMyLocationForHandle (IMHandle) threw: %@", e]);
            }
            fmrTrace(@"POLL", ([NSString stringWithFormat:
                @"IMFindMyLocation (via IMHandle): %@",
                imfmLocation ? NSStringFromClass([imfmLocation class]) : @"nil"]));
            if (imfmLocation) {
                id fmfLoc = nil; id fmlLoc = nil; NSString *shortAddr = nil;
                @try { fmfLoc = [imfmLocation performSelector:@selector(fmfLocation)]; } @catch (...) {}
                @try { fmlLoc = [imfmLocation performSelector:@selector(fmlLocation)]; } @catch (...) {}
                @try { shortAddr = [imfmLocation performSelector:@selector(shortAddress)]; } @catch (...) {}
                fmrTrace(@"POLL", ([NSString stringWithFormat:
                    @"backing: fmf=%@ fml=%@ short=%@",
                    fmfLoc ? NSStringFromClass([fmfLoc class]) : @"nil",
                    fmlLoc ? NSStringFromClass([fmlLoc class]) : @"nil",
                    shortAddr ?: @"nil"]));
                if (fmfLoc) {
                    writeLocationFromFMFObject(fmfLoc, address);
                    return YES;
                }
                // The Swift FMLLocation exposes scalar lat/lng/etc. as
                // direct NSNumber properties via KVC. The `coordinate`
                // SELECTOR returns (0,0) via NSInvocation because Swift
                // computed structs don't bridge cleanly that way — but
                // the individual `latitude` / `longitude` numbers bridge
                // perfectly. This is the safe read path.
                CLLocationCoordinate2D coord = {0, 0};
                NSNumber *latNum = nil;
                NSNumber *lngNum = nil;
                NSNumber *accNum = nil;
                NSNumber *altNum = nil;
                NSNumber *tsNum = nil;
                NSString *coarseLabel = nil;
                id placemark = nil;
                if (fmlLoc) {
                    @try { latNum = [fmlLoc valueForKey:@"latitude"]; } @catch (...) {}
                    @try { lngNum = [fmlLoc valueForKey:@"longitude"]; } @catch (...) {}
                    @try { accNum = [fmlLoc valueForKey:@"horizontalAccuracy"]; } @catch (...) {}
                    @try { altNum = [fmlLoc valueForKey:@"altitude"]; } @catch (...) {}
                    @try { tsNum  = [fmlLoc valueForKey:@"timestamp"]; } @catch (...) {}
                    @try { coarseLabel = [fmlLoc valueForKey:@"coarseAddressLabel"]; } @catch (...) {}
                    @try { placemark   = [fmlLoc valueForKey:@"address"]; } @catch (...) {}
                    if (latNum && lngNum) {
                        coord.latitude  = [latNum doubleValue];
                        coord.longitude = [lngNum doubleValue];
                    }
                }
                fmrTrace(@"POLL", ([NSString stringWithFormat:@"coord (KVC): lat=%f lng=%f acc=%@",
                    coord.latitude, coord.longitude, accNum]));
                NSMutableDictionary *out = [NSMutableDictionary dictionary];
                out[@"address"] = address;
                out[@"source"] = @"imfindmylocation";
                out[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
                if (shortAddr) out[@"coarseAddress"] = shortAddr;
                if (coarseLabel && !shortAddr) out[@"coarseAddress"] = coarseLabel;
                if (CLLocationCoordinate2DIsValid(coord) && (coord.latitude != 0 || coord.longitude != 0)) {
                    out[@"latitude"]  = @(coord.latitude);
                    out[@"longitude"] = @(coord.longitude);
                }
                if (accNum) out[@"horizontalAccuracy"] = accNum;
                if (altNum) out[@"altitude"] = altNum;
                if (tsNum)  out[@"locationTimestamp"] = tsNum;
                // Try to pull formatted address from the FMLPlaceMark
                if (placemark) {
                    NSString *locality = nil;
                    NSString *stateCode = nil;
                    NSString *country = nil;
                    NSString *streetAddress = nil;
                    NSString *streetName = nil;
                    @try { locality = [placemark valueForKey:@"locality"]; } @catch (...) {}
                    @try { stateCode = [placemark valueForKey:@"stateCode"]; } @catch (...) {}
                    @try { country = [placemark valueForKey:@"country"]; } @catch (...) {}
                    @try { streetAddress = [placemark valueForKey:@"streetAddress"]; } @catch (...) {}
                    @try { streetName = [placemark valueForKey:@"streetName"]; } @catch (...) {}
                    NSMutableArray *parts = [NSMutableArray array];
                    if (streetAddress.length) [parts addObject:streetAddress];
                    else if (streetName.length && ![streetName isEqualToString:@"."]) [parts addObject:streetName];
                    if (locality.length) [parts addObject:locality];
                    if (stateCode.length) [parts addObject:stateCode];
                    if (country.length) [parts addObject:country];
                    if (parts.count > 0) {
                        out[@"formattedAddress"] = [parts componentsJoinedByString:@", "];
                    }
                }
                // Success requires either coords or an address.
                BOOL hasCoords = (coord.latitude != 0 || coord.longitude != 0);
                BOOL hasAddress = (shortAddr.length > 0 || coarseLabel.length > 0 || out[@"formattedAddress"]);
                out[@"success"] = @(hasCoords || hasAddress);
                if (!hasCoords && !hasAddress) {
                    out[@"error"] = @"IMFindMyLocation present but no usable data";
                }
                writeResult(@"findmy-location.json", out);
                return YES;
            }
        }
    }

    // ─── PATH 0a: Use IMFMFSession's own list of sharing handles ─────
    //
    // Instead of constructing an IMFindMyHandle ourselves (which fails
    // because Apple's findMyLocationForHandle: calls a missing selector
    // on it on macOS 15.5), get a properly-constructed handle FROM the
    // session itself via findMyHandlesSharingLocationWithMe, then pass
    // it back into findMyLocationForHandle:.
    if ([imfmf respondsToSelector:@selector(findMyHandlesSharingLocationWithMe)]
        && [imfmf respondsToSelector:@selector(findMyLocationForHandle:)]) {
        id sharingHandles = nil;
        @try {
            sharingHandles = [imfmf performSelector:@selector(findMyHandlesSharingLocationWithMe)];
        } @catch (NSException *e) {
            fmrTrace(@"POLL", [NSString stringWithFormat:@"findMyHandlesSharingLocationWithMe threw: %@", e]);
        }
        fmrTrace(@"POLL", ([NSString stringWithFormat:
            @"sharing handles: count=%lu class=%@",
            (unsigned long)[sharingHandles count],
            sharingHandles ? NSStringFromClass([sharingHandles class]) : @"nil"]));
        // Accept NSArray, NSSet, or anything else iterable that responds to
        // `count` and supports fast-enumeration. Apple returns NSSingleObjectSetI here.
        if (sharingHandles && [sharingHandles respondsToSelector:@selector(count)]
            && [sharingHandles count] > 0) {
            // Find a handle whose identifier matches our address.
            id matchedHandle = nil;
            for (id h in (id<NSFastEnumeration>)sharingHandles) {
                NSString *hid = nil;
                @try { hid = [h performSelector:@selector(identifier)]; } @catch (...) {}
                fmrTrace(@"POLL", ([NSString stringWithFormat:
                    @"  candidate handle: %@ id=%@",
                    NSStringFromClass([h class]), hid ?: @"(no identifier)"]));
                if ([hid isEqualToString:address]) { matchedHandle = h; break; }
                if (hid && [hid rangeOfString:address].location != NSNotFound) {
                    matchedHandle = h;
                    break;
                }
            }
            if (!matchedHandle && [sharingHandles count] == 1) {
                // Single user case: just take the only handle (it's us).
                for (id h in (id<NSFastEnumeration>)sharingHandles) { matchedHandle = h; break; }
                fmrTrace(@"POLL", @"using only sharing handle (single-user fallback)");
            }
            if (matchedHandle) {
                id imfmLocation = nil;
                @try {
                    imfmLocation = [imfmf performSelector:@selector(findMyLocationForHandle:)
                                              withObject:matchedHandle];
                } @catch (NSException *e) {
                    fmrTrace(@"POLL", [NSString stringWithFormat:
                        @"findMyLocationForHandle (matched) threw: %@", e]);
                }
                fmrTrace(@"POLL", ([NSString stringWithFormat:
                    @"IMFindMyLocation (matched): %@",
                    imfmLocation ? NSStringFromClass([imfmLocation class]) : @"nil"]));
                if (imfmLocation) {
                    id fmfLoc = nil; id fmlLoc = nil; NSString *shortAddr = nil;
                    @try { fmfLoc = [imfmLocation performSelector:@selector(fmfLocation)]; } @catch (...) {}
                    @try { fmlLoc = [imfmLocation performSelector:@selector(fmlLocation)]; } @catch (...) {}
                    @try { shortAddr = [imfmLocation performSelector:@selector(shortAddress)]; } @catch (...) {}
                    fmrTrace(@"POLL", ([NSString stringWithFormat:
                        @"backing: fmf=%@ fml=%@ short=%@",
                        fmfLoc ? NSStringFromClass([fmfLoc class]) : @"nil",
                        fmlLoc ? NSStringFromClass([fmlLoc class]) : @"nil",
                        shortAddr ?: @"nil"]));
                    if (fmfLoc) {
                        writeLocationFromFMFObject(fmfLoc, address);
                        return YES;
                    }
                    // No FMF backing — write whatever shortAddress we got
                    NSMutableDictionary *out = [NSMutableDictionary dictionary];
                    out[@"success"] = (shortAddr ? @YES : @NO);
                    out[@"address"] = address;
                    out[@"source"] = @"imfindmylocation";
                    out[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
                    if (shortAddr) out[@"coarseAddress"] = shortAddr;
                    if (!shortAddr) out[@"error"] = @"IMFindMyLocation present but no fmfLocation or shortAddress";
                    writeResult(@"findmy-location.json", out);
                    return YES;
                }
            }
        }
    }

    Class IMFindMyHandleClass = NSClassFromString(@"IMFindMyHandle");
    Class FMFHandleProbeClass = NSClassFromString(@"FMFHandle");
    Class FMLHandleProbeClass = NSClassFromString(@"FMLHandle");
    if (IMFindMyHandleClass && [imfmf respondsToSelector:@selector(findMyLocationForHandle:)]) {
        // Try multiple ways to construct the IMFindMyHandle since the
        // identifier-only path leads to a half-initialized handle whose
        // findMyHandle selector is missing on macOS 15.5.
        // Variant A: wrap an FMFHandle (older Obj-C handle)
        id imfmHandle = nil;
        if (FMFHandleProbeClass) {
            id fmfH = [FMFHandleProbeClass performSelector:@selector(handleWithId:) withObject:address];
            if (fmfH && [IMFindMyHandleClass respondsToSelector:@selector(handleWithFMFHandle:)]) {
                imfmHandle = [IMFindMyHandleClass performSelector:@selector(handleWithFMFHandle:)
                                                       withObject:fmfH];
                fmrTrace(@"POLL", ([NSString stringWithFormat:
                    @"IMFindMyHandle via handleWithFMFHandle: %@",
                    imfmHandle ? @"YES" : @"NIL"]));
            }
        }
        // Variant B: wrap an FMLHandle (newer)
        if (!imfmHandle && FMLHandleProbeClass) {
            id fmlH = [FMLHandleProbeClass performSelector:@selector(handleWithIdentifier:) withObject:address];
            if (fmlH && [IMFindMyHandleClass respondsToSelector:@selector(handleWithFMLHandle:)]) {
                imfmHandle = [IMFindMyHandleClass performSelector:@selector(handleWithFMLHandle:)
                                                       withObject:fmlH];
                fmrTrace(@"POLL", ([NSString stringWithFormat:
                    @"IMFindMyHandle via handleWithFMLHandle: %@",
                    imfmHandle ? @"YES" : @"NIL"]));
            }
        }
        // Variant C: bare identifier (what we tried before)
        if (!imfmHandle) {
            imfmHandle = [IMFindMyHandleClass performSelector:@selector(handleWithIdentifier:)
                                                   withObject:address];
            fmrTrace(@"POLL", ([NSString stringWithFormat:
                @"IMFindMyHandle via handleWithIdentifier: %@",
                imfmHandle ? @"YES" : @"NIL"]));
        }
        if (imfmHandle) {
            id imfmLocation = nil;
            @try {
                imfmLocation = [imfmf performSelector:@selector(findMyLocationForHandle:)
                                          withObject:imfmHandle];
            } @catch (NSException *e) {
                fmrTrace(@"POLL", [NSString stringWithFormat:@"findMyLocationForHandle threw: %@", e]);
            }
            fmrTrace(@"POLL", ([NSString stringWithFormat:
                @"IMFindMyLocation result: %@ (class=%@)",
                imfmLocation ? @"YES" : @"NIL",
                imfmLocation ? NSStringFromClass([imfmLocation class]) : @"-"]));
            if (imfmLocation) {
                // IMFindMyLocation has fmfLocation + fmlLocation properties.
                // Try to extract usable coords from either backing store.
                id fmfLoc = nil;
                id fmlLoc = nil;
                @try { fmfLoc = [imfmLocation performSelector:@selector(fmfLocation)]; } @catch (...) {}
                @try { fmlLoc = [imfmLocation performSelector:@selector(fmlLocation)]; } @catch (...) {}
                NSString *shortAddr = nil;
                @try { shortAddr = [imfmLocation performSelector:@selector(shortAddress)]; } @catch (...) {}
                fmrTrace(@"POLL", ([NSString stringWithFormat:
                    @"IMFindMyLocation backing: fmf=%@ fml=%@ shortAddress=%@",
                    fmfLoc ? NSStringFromClass([fmfLoc class]) : @"nil",
                    fmlLoc ? NSStringFromClass([fmlLoc class]) : @"nil",
                    shortAddr ?: @"nil"]));
                // Prefer FMF (no Swift bridge) over FML for the actual coord read.
                if (fmfLoc) {
                    writeLocationFromFMFObject(fmfLoc, address);
                    return YES;
                }
                // No FMF — try writing what we can from the IMFindMyLocation wrapper itself.
                NSMutableDictionary *out = [NSMutableDictionary dictionary];
                out[@"success"] = @YES;
                out[@"address"] = address;
                out[@"source"] = @"imfindmylocation";
                out[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
                if (shortAddr) out[@"coarseAddress"] = shortAddr;
                writeResult(@"findmy-location.json", out);
                return YES;
            }
        }
    }

    // ─── PATH A: FMFSession (Obj-C, no Swift bridge) ─────────────────
    //
    // macOS 15.5 made FindMyLocateSession.cachedLocationForHandle:includeAddress:
    // crash on every call — the Swift-backed
    // `com.apple.findmy.findmylocated.ObjCBootstrap` queue segfaults in
    // objc_retain inside Apple's framework. FMFSession is the older,
    // pure-Obj-C parallel that doesn't go through that queue. Try it
    // first; only fall back to FML if FMF is unavailable (older OSes).
    Class FMFHandleClass = NSClassFromString(@"FMFHandle");
    Class FMFSessionClass = NSClassFromString(@"FMFSession");
    id fmfSession = nil;
    // Try IMFMFSession.session first (older path)
    @try {
        fmfSession = [imfmf valueForKey:@"session"];
    } @catch (NSException *e) {
        fmrTrace(@"POLL", [NSString stringWithFormat:@"IMFMFSession.session threw: %@", e]);
    }
    // Fall back to FMFSession.sharedInstance
    if (!fmfSession && FMFSessionClass
        && [FMFSessionClass respondsToSelector:@selector(sharedInstance)]) {
        @try {
            fmfSession = [FMFSessionClass performSelector:@selector(sharedInstance)];
        } @catch (NSException *e) {
            fmrTrace(@"POLL", [NSString stringWithFormat:@"FMFSession.sharedInstance threw: %@", e]);
        }
    }
    fmrTrace(@"POLL", ([NSString stringWithFormat:
        @"FMF probe: FMFHandleClass=%@ FMFSessionClass=%@ fmfSession=%@ class=%@",
        FMFHandleClass ? @"YES" : @"NIL",
        FMFSessionClass ? @"YES" : @"NIL",
        fmfSession ? @"YES" : @"NIL",
        fmfSession ? NSStringFromClass([fmfSession class]) : @"-"]));
    if (fmfSession && FMFHandleClass) {
        id fmfHandle = [FMFHandleClass performSelector:@selector(handleWithId:)
                                            withObject:address];
        SEL fmfCachedSel = @selector(cachedLocationForHandle:);
        if (fmfHandle && [fmfSession respondsToSelector:fmfCachedSel]) {
            id cached = [fmfSession performSelector:fmfCachedSel withObject:fmfHandle];
            if (cached) {
                fmrTrace(@"POLL", [NSString stringWithFormat:@"FMF cache hit for %@", address]);
                writeLocationFromFMFObject(cached, address);
                return YES;
            }
            fmrTrace(@"POLL", [NSString stringWithFormat:@"FMF cache miss for %@; triggering refresh", address]);
            // Cache miss — fmfd populates FMLSession's cache from background
            // pushes but not necessarily FMFSession's. Ask FMFSession to
            // refresh once; it'll push the result into its own cache and
            // the next poll will cache-hit. This call is pure Obj-C
            // (refreshLocationForHandle:callerId:priority:completion:),
            // not the Swift-bridged thing that crashes.
            SEL fmfRefreshSel = @selector(refreshLocationForHandle:callerId:priority:completion:);
            if (![fmfSession respondsToSelector:fmfRefreshSel]) {
                fmrTrace(@"POLL", @"FMFSession has no refreshLocationForHandle: — fmfd may not push to it");
                writeResult(@"findmy-location.json", @{
                    @"success": @NO,
                    @"error": @"FMF refresh unavailable",
                    @"address": address,
                    @"source": @"fmf",
                    @"timestamp": @([[NSDate date] timeIntervalSince1970]),
                });
                return YES;
            }

            if (![FindMyRequestSender claimRefreshSlotForAddress:address]) {
                writeResult(@"findmy-location.json", @{
                    @"success": @NO,
                    @"error": @"FMF refresh in flight",
                    @"address": address,
                    @"timestamp": @([[NSDate date] timeIntervalSince1970]),
                });
                return YES;
            }

            // Block completion: re-read cache, write result, release slot.
            void (^onFMFRefreshed)(id) = ^(id err) {
                if (err) {
                    fmrTrace(@"POLL", [NSString stringWithFormat:@"FMF refresh completion err: %@", err]);
                }
                id postCached = [fmfSession performSelector:fmfCachedSel withObject:fmfHandle];
                if (postCached) {
                    writeLocationFromFMFObject(postCached, address);
                } else {
                    writeResult(@"findmy-location.json", @{
                        @"success": @NO,
                        @"error": @"FMF refresh completed but cache still empty",
                        @"address": address,
                        @"source": @"fmf",
                        @"timestamp": @([[NSDate date] timeIntervalSince1970]),
                    });
                }
                [FindMyRequestSender releaseRefreshSlotForAddress:address];
            };

            NSMethodSignature *rsig = [fmfSession methodSignatureForSelector:fmfRefreshSel];
            NSInvocation *rinv = [NSInvocation invocationWithMethodSignature:rsig];
            [rinv setTarget:fmfSession];
            [rinv setSelector:fmfRefreshSel];
            id callerId = @"com.apple.findmy.FindMyMessagesApp";
            NSInteger priority = 1;
            id block = [onFMFRefreshed copy];
            [rinv setArgument:&fmfHandle atIndex:2];
            [rinv setArgument:&callerId atIndex:3];
            [rinv setArgument:&priority atIndex:4];
            [rinv setArgument:&block atIndex:5];
            [rinv retainArguments];
            [rinv invoke];
            fmrTrace(@"POLL", @"FMF refresh dispatched");
            return YES;
        }
        fmrTrace(@"POLL", @"FMFSession or FMFHandle unavailable; falling through to FML");
    }

    // ─── PATH B: FindMyLocateSession (Swift-bridged) ─────────────────
    //
    // Disabled by default — known to crash Messages on macOS 15.5.
    // Re-enable only via env var FINDMY_ALLOW_FML=1 for
    // diagnostic builds. The path is preserved so we can re-run probes
    // if Apple ships a fix.
    NSString *allowFML = [[[NSProcessInfo processInfo] environment] objectForKey:@"FINDMY_ALLOW_FML"];
    if (![allowFML isEqualToString:@"1"]) {
        writeResult(@"findmy-location.json", @{
            @"success": @NO,
            @"error": @"FMF path returned nothing; FML path disabled (set FINDMY_ALLOW_FML=1 to enable)",
            @"address": address,
            @"timestamp": @([[NSDate date] timeIntervalSince1970]),
        });
        return YES;
    }

    Class FMLHandleClass = NSClassFromString(@"FMLHandle");
    id fmlHandle = [FMLHandleClass performSelector:@selector(handleWithIdentifier:) withObject:address];
    if (!fmlHandle) FMR_FAIL(@"FMLHandle nil");

    id fmlSession = [imfmf valueForKey:@"fmlSession"];
    if (!fmlSession) FMR_FAIL(@"fmlSession nil");

    SEL cachedSel = @selector(cachedLocationForHandle:includeAddress:);
    if (![fmlSession respondsToSelector:cachedSel]) FMR_FAIL(@"no cachedLocationForHandle method");

    id cached = nil;
    {
        NSMethodSignature *cs = [fmlSession methodSignatureForSelector:cachedSel];
        NSInvocation *ci = [NSInvocation invocationWithMethodSignature:cs];
        [ci setTarget:fmlSession];
        [ci setSelector:cachedSel];
        BOOL inc = YES;
        [ci setArgument:&fmlHandle atIndex:2];
        [ci setArgument:&inc atIndex:3];
        [ci invoke];
        [ci getReturnValue:&cached];
    }
    if (cached) {
        fmrTrace(@"POLL", [NSString stringWithFormat:@"FML cache hit for %@", address]);
        writeLocationFromFMLObject(cached, address);
        return YES;
    }

    if (![self claimRefreshSlotForAddress:address]) {
        fmrTrace(@"POLL", [NSString stringWithFormat:@"FML refresh already in flight for %@; skipping", address]);
        writeResult(@"findmy-location.json", @{@"success": @NO, @"error": @"refresh in flight"});
        return YES;
    }

    SEL refreshSel = @selector(startRefreshingLocationForHandles:priority:isFromGroup:reverseGeocode:completion:);
    if (![fmlSession respondsToSelector:refreshSel]) {
        [self releaseRefreshSlotForAddress:address];
        FMR_FAIL(@"no refresh method");
    }

    fmrTrace(@"POLL", [NSString stringWithFormat:@"FML refresh+fetch %@", address]);

    void (^onRefreshed)(void) = ^{
        id location = nil;
        NSMethodSignature *cs = [fmlSession methodSignatureForSelector:cachedSel];
        NSInvocation *ci = [NSInvocation invocationWithMethodSignature:cs];
        [ci setTarget:fmlSession];
        [ci setSelector:cachedSel];
        BOOL inc = YES;
        [ci setArgument:&fmlHandle atIndex:2];
        [ci setArgument:&inc atIndex:3];
        [ci invoke];
        [ci getReturnValue:&location];

        writeLocationFromFMLObject(location, address);
        [FindMyRequestSender releaseRefreshSlotForAddress:address];
    };

    NSMethodSignature *sig = [fmlSession methodSignatureForSelector:refreshSel];
    NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
    [inv setTarget:fmlSession]; [inv setSelector:refreshSel];
    NSArray *handles = @[fmlHandle];
    long long priority = 100;
    BOOL isFromGroup = NO;
    BOOL reverseGeocode = YES;
    id block = [onRefreshed copy];
    [inv setArgument:&handles atIndex:2];
    [inv setArgument:&priority atIndex:3];
    [inv setArgument:&isFromGroup atIndex:4];
    [inv setArgument:&reverseGeocode atIndex:5];
    [inv setArgument:&block atIndex:6];
    [inv retainArguments];
    [inv invoke];
    return YES;
    #undef FMR_FAIL
}

+ (BOOL)statusDump:(NSString **)errorOut {
    Class IMFMFSessionClass = NSClassFromString(@"IMFMFSession");
    id imfmf = [IMFMFSessionClass performSelector:@selector(sharedInstance)];
    id fmlSession = [imfmf valueForKey:@"fmlSession"];
    if (!fmlSession) { if (errorOut) *errorOut = @"fmlSession nil"; return NO; }

    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    out[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
    out[@"fmlSessionClass"] = NSStringFromClass([fmlSession class]);

    fmrTrace(@"STATUS", @"requesting SHARING_WITH_ME + FOLLOWING_ME");

    __block NSArray *sharingWithMe = nil;
    __block NSArray *followingMe = nil;

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block int remaining = 2;

    void (^onBoth)(void) = ^{
        if (--remaining == 0) dispatch_semaphore_signal(sem);
    };

    if ([fmlSession respondsToSelector:@selector(getFriendsSharingLocationsWithMeWithCompletion:)]) {
        void (^cb1)(NSArray *) = ^(NSArray *friends) {
            sharingWithMe = friends ?: @[];
            onBoth();
        };
        id b1 = [cb1 copy];
        [fmlSession performSelector:@selector(getFriendsSharingLocationsWithMeWithCompletion:) withObject:b1];
    } else { remaining--; }

    if ([fmlSession respondsToSelector:@selector(getFriendsFollowingMyLocationWithCompletion:)]) {
        void (^cb2)(NSArray *) = ^(NSArray *friends) {
            followingMe = friends ?: @[];
            onBoth();
        };
        id b2 = [cb2 copy];
        [fmlSession performSelector:@selector(getFriendsFollowingMyLocationWithCompletion:) withObject:b2];
    } else { remaining--; }

    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)));

    NSMutableArray *sharingArr = [NSMutableArray array];
    for (id f in sharingWithMe) [sharingArr addObject:[f description]];
    NSMutableArray *followingArr = [NSMutableArray array];
    for (id f in followingMe) [followingArr addObject:[f description]];

    out[@"sharing_with_me"] = sharingArr;
    out[@"following_me"] = followingArr;
    out[@"sharing_with_me_count"] = @(sharingArr.count);
    out[@"following_me_count"] = @(followingArr.count);

    fmrTrace(@"STATUS", [NSString stringWithFormat:@"sharing=%lu following=%lu",
        (unsigned long)sharingArr.count, (unsigned long)followingArr.count]);

    writeResult(@"findmy-status.json", out);
    return YES;
}

+ (BOOL)sendLocationRequestToAddress:(NSString *)address error:(NSString **)errorOut {
    return [self shareLocationWithAddress:address error:errorOut];
}

// Look up every Obj-C class that responds to a given selector. Used to
// hunt for the renamed/relocated `findMyHandle` implementor.
+ (BOOL)hunt:(NSString *)selectorName errorOut:(NSString **)errorOut {
    SEL sel = NSSelectorFromString(selectorName);
    if (!sel) {
        if (errorOut) *errorOut = @"invalid selector";
        return NO;
    }
    NSMutableArray *matches = [NSMutableArray array];
    unsigned int total = 0;
    Class *classes = objc_copyClassList(&total);
    for (unsigned int i = 0; i < total; i++) {
        Class c = classes[i];
        if (!c) continue;
        const char *cname = class_getName(c);
        if (!cname) continue;
        // Skip swift symbols (start with _T) and Apple's internal _ prefix
        NSString *name = [NSString stringWithUTF8String:cname];
        // Use class_respondsToSelector / class_getInstanceMethod safely.
        if (class_getInstanceMethod(c, sel)
            || class_getClassMethod(c, sel)) {
            [matches addObject:name];
        }
    }
    free(classes);
    [matches sortUsingSelector:@selector(compare:)];
    NSDictionary *out = @{
        @"selector": selectorName,
        @"timestamp": @([[NSDate date] timeIntervalSince1970]),
        @"match_count": @(matches.count),
        @"matches": matches,
    };
    writeResult(@"findmy-hunt.json", out);
    fmrTrace(@"HUNT", ([NSString stringWithFormat:@"%@ -> %lu matches", selectorName, (unsigned long)matches.count]));
    return YES;
}

// Dump the full method/property surface of relevant classes to a JSON file
// so we can discover non-crashing paths to location data. Pure introspection
// — never invokes the methods, just lists them.
+ (BOOL)probeRuntime:(NSString **)errorOut {
    NSArray<NSString *> *classNames = @[
        @"IMLocationManager",
        @"IMLocationManagerUtils",
        @"IMFindMyHandle",
        @"IMFindMyLocation",
        @"IMFindMyDevice",
        @"IMFMFSession",
        @"FMFSession",
        @"FMFSessionDataManager",
        @"FMFLocation",
        @"FMFHandle",
        @"FindMyLocateSession",
        @"FMLLocation",
        @"FMLHandle",
        @"IMLocatingChatItem",
    ];

    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    result[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
    NSMutableDictionary *classes = [NSMutableDictionary dictionary];

    for (NSString *name in classNames) {
        Class cls = NSClassFromString(name);
        NSMutableDictionary *info = [NSMutableDictionary dictionary];
        info[@"exists"] = @(cls != nil);
        if (!cls) { classes[name] = info; continue; }

        info[@"superclass"] = NSStringFromClass([cls superclass]) ?: @"";

        // Class methods
        NSMutableArray *classMethods = [NSMutableArray array];
        unsigned int cmCount = 0;
        Method *cm = class_copyMethodList(object_getClass(cls), &cmCount);
        for (unsigned int i = 0; i < cmCount; i++) {
            [classMethods addObject:NSStringFromSelector(method_getName(cm[i]))];
        }
        free(cm);
        info[@"class_methods"] = classMethods;

        // Instance methods (drill down current class only, no inherited)
        NSMutableArray *instMethods = [NSMutableArray array];
        unsigned int imCount = 0;
        Method *im = class_copyMethodList(cls, &imCount);
        for (unsigned int i = 0; i < imCount; i++) {
            [instMethods addObject:NSStringFromSelector(method_getName(im[i]))];
        }
        free(im);
        info[@"instance_methods"] = instMethods;

        // Properties
        NSMutableArray *properties = [NSMutableArray array];
        unsigned int pCount = 0;
        objc_property_t *props = class_copyPropertyList(cls, &pCount);
        for (unsigned int i = 0; i < pCount; i++) {
            const char *pname = property_getName(props[i]);
            const char *pattr = property_getAttributes(props[i]);
            [properties addObject:@{
                @"name": [NSString stringWithUTF8String:pname],
                @"attributes": [NSString stringWithUTF8String:pattr ?: ""],
            }];
        }
        free(props);
        info[@"properties"] = properties;

        // Ivars
        NSMutableArray *ivars = [NSMutableArray array];
        unsigned int ivCount = 0;
        Ivar *ivs = class_copyIvarList(cls, &ivCount);
        for (unsigned int i = 0; i < ivCount; i++) {
            const char *iname = ivar_getName(ivs[i]);
            const char *itype = ivar_getTypeEncoding(ivs[i]);
            [ivars addObject:@{
                @"name": [NSString stringWithUTF8String:iname ?: "?"],
                @"type": [NSString stringWithUTF8String:itype ?: "?"],
            }];
        }
        free(ivs);
        info[@"ivars"] = ivars;

        classes[name] = info;
    }
    result[@"classes"] = classes;

    // Also probe IMFMFSession.sharedInstance for which ivar/properties are non-nil
    Class IMFMFSessionClass = NSClassFromString(@"IMFMFSession");
    if (IMFMFSessionClass) {
        id imfmf = [IMFMFSessionClass performSelector:@selector(sharedInstance)];
        NSMutableDictionary *sessionState = [NSMutableDictionary dictionary];
        sessionState[@"_sharedInstance_class"] = NSStringFromClass([imfmf class]) ?: @"nil";
        // List runtime ivars and their non-nil status
        NSMutableArray *populated = [NSMutableArray array];
        unsigned int ivCount = 0;
        Ivar *ivs = class_copyIvarList([imfmf class], &ivCount);
        for (unsigned int i = 0; i < ivCount; i++) {
            const char *iname = ivar_getName(ivs[i]);
            if (!iname) continue;
            NSString *name = [NSString stringWithUTF8String:iname];
            // Skip ivars that are obviously primitive (BOOL flags, etc.)
            const char *type = ivar_getTypeEncoding(ivs[i]);
            if (!type || type[0] != '@') continue;
            @try {
                NSString *key = [name hasPrefix:@"_"] ? [name substringFromIndex:1] : name;
                id v = [imfmf valueForKey:key];
                [populated addObject:@{
                    @"ivar": name,
                    @"key": key,
                    @"populated": @(v != nil),
                    @"class": v ? NSStringFromClass([v class]) : @"nil",
                }];
            } @catch (NSException *e) {
                [populated addObject:@{@"ivar": name, @"key": @"(threw)", @"error": e.reason ?: @""}];
            }
        }
        free(ivs);
        sessionState[@"ivars"] = populated;
        result[@"imfmf_session_state"] = sessionState;
    }

    writeResult(@"findmy-probe.json", result);
    fmrTrace(@"PROBE", @"runtime probe written");
    return YES;
}

+ (BOOL)dispatchAction:(NSString *)action address:(NSString *)address error:(NSString **)errorOut {
    [[NSFileManager defaultManager] removeItemAtPath:
        [NSTemporaryDirectory() stringByAppendingPathComponent:@"findmy-trace.log"]
                                                error:nil];
    fmrTrace(@"BEGIN", [NSString stringWithFormat:@"action=%@ address=%@", action, address]);

    if ([action isEqualToString:@"poll"])   return [self pollLocationForAddress:address error:errorOut];
    if ([action isEqualToString:@"stop"])   return [self stopSharingWithAddress:address error:errorOut];
    if ([action isEqualToString:@"status"]) return [self statusDump:errorOut];
    if ([action isEqualToString:@"probe"])  return [self probeRuntime:errorOut];
    if ([action isEqualToString:@"hunt"])   return [self hunt:address errorOut:errorOut];
    return [self shareLocationWithAddress:address error:errorOut];
}

@end
