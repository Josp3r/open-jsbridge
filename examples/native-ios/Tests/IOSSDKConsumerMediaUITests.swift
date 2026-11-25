import XCTest

final class IOSSDKConsumerMediaUITests: XCTestCase {
    @MainActor
    func testSharedH5ReadsTheExactImageFromTheSystemPhotoPicker() throws {
        continueAfterFailure = false
        let fixtureURL = try XCTUnwrap(Bundle(for: IOSSDKConsumerMediaUITests.self)
            .url(forResource: "MediaFixture", withExtension: "png"))
        let expected = try Data(contentsOf: fixtureURL)
        let app = XCUIApplication()
        app.launchEnvironment["OJSB_EXPECTED_MEDIA_BASE64"] = expected.base64EncodedString()
        app.launch()

        let page = app.webViews.firstMatch
        let choose = page.buttons["Choose image"]
        XCTAssertTrue(choose.waitForExistence(timeout: 20))
        choose.tap()
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 20), app.debugDescription)
        cancel.tap()
        XCTAssertTrue(page.staticTexts["Selection cancelled"].waitForExistence(timeout: 20), app.debugDescription)

        choose.tap()
        let fixture = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        XCTAssertTrue(fixture.waitForExistence(timeout: 45), app.debugDescription)
        fixture.tap()

        let result = page.staticTexts["Verified \(expected.count) bytes"]
        XCTAssertTrue(result.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(page.images["Selected image"].exists)
    }
}
