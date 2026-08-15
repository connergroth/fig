//
//  FindMyRequestSender.h
//  findmy-dylib
//
//  Sends a Find My "Request Location" balloon via iMessage, matching the
//  exact payload Messages.app produces when a user taps Contact Header →
//  Request Location. The recipient sees a tappable "Share" button; tapping
//  it triggers their local FindMyMessagesApp extension to share location.
//

#import <Foundation/Foundation.h>

@interface FindMyRequestSender : NSObject

// Legacy entry — defaults to "share" action.
+ (BOOL)sendLocationRequestToAddress:(NSString *)address
                               error:(NSString **)errorOut;

// Action dispatcher. action ∈ {"share", "poll"}.
//   "share" = [chat shareLocationWithDuration:0] — onboarding handshake
//   "poll"  = FMLSession refresh + cachedLocationForHandle — silent read
+ (BOOL)dispatchAction:(NSString *)action
               address:(NSString *)address
                 error:(NSString **)errorOut;

// Individual entry points (used by dispatchAction).
+ (BOOL)shareLocationWithAddress:(NSString *)address error:(NSString **)errorOut;
+ (BOOL)pollLocationForAddress:(NSString *)address error:(NSString **)errorOut;

@end
